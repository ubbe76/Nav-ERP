import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@navet/db";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createEconomyRepository } from "../src/modules/economy/repository/economy.repository.js";
import {
  createEconomyService,
  DuplicateVerificationSeriesError,
  SeriesCodeLockedError,
  VerificationSeriesNotFoundError,
} from "../src/modules/economy/service/economy.service.js";
import { allocateVerificationNumber } from "../src/modules/economy/service/verification-number.js";

// audit is unused by every series/allocator method exercised here — a no-op
// stub, same as economy-accounts.test.ts.
const repo = createEconomyRepository(db);
const service = createEconomyService(repo, { log: async () => {} });
const authRepo = createAuthRepository(db);

// The seeded series 'A' (migration 0052) is truncated too — tests create
// their own series, never rely on the seed. verification_rows/verifications/
// accounts are needed for the code-lock test below, which books a real
// verification to prove a used series' code becomes immutable.
const TRUNCATE = sql`TRUNCATE verification_rows, verifications, verification_counters, verification_series, accounting_periods, fiscal_years, accounts, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

async function makeFiscalYear(label: string, startDate: string, endDate: string) {
  return service.createFiscalYear({ label, startDate, endDate });
}

async function makeUser(name = "Ekonomiadmin") {
  return authRepo.create({
    email: `economy-series-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name,
    role: "admin",
  });
}

async function makeAccount(number: string, name: string) {
  return service.createAccount({ number, name });
}

describe("economy service — verification series", () => {
  it("creates and lists a series", async () => {
    const created = await service.createSeries({ code: "A", name: "Manuella verifikat" });
    expect(created).toMatchObject({ code: "A", name: "Manuella verifikat" });

    const listed = await service.listSeries();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ code: "A", name: "Manuella verifikat" });
  });

  it("rejects a duplicate series code", async () => {
    await service.createSeries({ code: "A", name: "Manuella verifikat" });
    await expect(service.createSeries({ code: "A", name: "Annat namn" })).rejects.toBeInstanceOf(
      DuplicateVerificationSeriesError
    );
  });

  it("updates code and/or name, allowing a series to keep its own code", async () => {
    const created = await service.createSeries({ code: "A", name: "Manuella verifikat" });

    // Keeping its own code is not a conflict (self-exclusion).
    const sameCode = await service.updateSeries(created.id, { code: "A", name: "Nytt namn" });
    expect(sameCode).toMatchObject({ code: "A", name: "Nytt namn" });

    const renamed = await service.updateSeries(created.id, { code: "B" });
    expect(renamed).toMatchObject({ code: "B", name: "Nytt namn" });
  });

  it("rejects renaming a series' code to one already used by a different series", async () => {
    await service.createSeries({ code: "A", name: "Manuella verifikat" });
    const other = await service.createSeries({ code: "B", name: "Andra verifikat" });

    await expect(service.updateSeries(other.id, { code: "A" })).rejects.toBeInstanceOf(DuplicateVerificationSeriesError);
  });

  it("throws VerificationSeriesNotFoundError when updating a non-existent series", async () => {
    await expect(
      service.updateSeries("00000000-0000-0000-0000-000000000000", { name: "X" })
    ).rejects.toBeInstanceOf(VerificationSeriesNotFoundError);
  });
});

// displayNumber ("<code>-<year>-<n>") is built at read time from the
// series' code — renaming it once the series has been used would
// retroactively renumber every historical verifikat and orphan any
// audit_log entityId that references the old string. The name has no such
// downstream reader, so it stays freely editable.
describe("economy service — verification series: code locked once used", () => {
  it("refuses a code change once the series has a verification, keeps the name editable, and still allows a code change on a never-used series", async () => {
    const user = await makeUser();
    await makeFiscalYear("2026", "2026-01-01", "2026-12-31");
    const series = await service.createSeries({ code: "A", name: "Manuella verifikat" });
    const bank = await makeAccount("1930", "Företagskonto/checkkonto");
    const revenue = await makeAccount("3001", "Försäljning");

    const draft = await service.createVerification(
      {
        seriesId: series.id,
        date: "2026-03-15",
        description: "Test",
        rows: [
          { accountId: bank.id, debit: 100, credit: 0 },
          { accountId: revenue.id, debit: 0, credit: 100 },
        ],
      },
      user.id
    );
    await service.book(draft.id, user.id);

    await expect(service.updateSeries(series.id, { code: "B" })).rejects.toBeInstanceOf(SeriesCodeLockedError);

    // Name-only patch on the same, now-used series still goes through.
    const renamedOnly = await service.updateSeries(series.id, { name: "Nytt namn" });
    expect(renamedOnly).toMatchObject({ code: "A", name: "Nytt namn" });

    // Re-submitting the SAME code (no actual change) is not a lock
    // violation either.
    const sameCode = await service.updateSeries(series.id, { code: "A" });
    expect(sameCode).toMatchObject({ code: "A" });

    // A series with zero verifications is unaffected by the lock.
    const unused = await service.createSeries({ code: "C", name: "Oanvänd serie" });
    const changed = await service.updateSeries(unused.id, { code: "D" });
    expect(changed).toMatchObject({ code: "D" });
  });
});

describe("allocateVerificationNumber", () => {
  it("allocates sequential numbers 1,2,3 for the same series+year inside one transaction", async () => {
    const series = await service.createSeries({ code: "A", name: "Manuella verifikat" });
    const year = await makeFiscalYear("2026", "2026-01-01", "2026-12-31");

    const numbers = await db.transaction(async (tx) => [
      await allocateVerificationNumber(tx, series.id, year.id),
      await allocateVerificationNumber(tx, series.id, year.id),
      await allocateVerificationNumber(tx, series.id, year.id),
    ]);

    expect(numbers).toEqual([1, 2, 3]);
  });

  it("keeps two series independent — each starts its own count at 1", async () => {
    const seriesA = await service.createSeries({ code: "A", name: "Manuella verifikat" });
    const seriesB = await service.createSeries({ code: "B", name: "Andra verifikat" });
    const year = await makeFiscalYear("2026", "2026-01-01", "2026-12-31");

    const [a1, a2, b1] = await db.transaction(async (tx) => [
      await allocateVerificationNumber(tx, seriesA.id, year.id),
      await allocateVerificationNumber(tx, seriesA.id, year.id),
      await allocateVerificationNumber(tx, seriesB.id, year.id),
    ]);

    expect(a1).toBe(1);
    expect(a2).toBe(2);
    expect(b1).toBe(1);
  });

  it("keeps the same series independent across two fiscal years", async () => {
    const series = await service.createSeries({ code: "A", name: "Manuella verifikat" });
    const year2026 = await makeFiscalYear("2026", "2026-01-01", "2026-12-31");
    const year2027 = await makeFiscalYear("2027", "2027-01-01", "2027-12-31");

    const n2026 = await db.transaction((tx) => allocateVerificationNumber(tx, series.id, year2026.id));
    const n2027 = await db.transaction((tx) => allocateVerificationNumber(tx, series.id, year2027.id));
    const n2026Again = await db.transaction((tx) => allocateVerificationNumber(tx, series.id, year2026.id));

    expect(n2026).toBe(1);
    expect(n2027).toBe(1);
    expect(n2026Again).toBe(2);
  });

  it("is safe under 20 concurrent transactions — 20 distinct sequential numbers 1..20", async () => {
    const series = await service.createSeries({ code: "A", name: "Manuella verifikat" });
    const year = await makeFiscalYear("2026", "2026-01-01", "2026-12-31");

    const results = await Promise.all(
      Array.from({ length: 20 }, () => db.transaction((tx) => allocateVerificationNumber(tx, series.id, year.id)))
    );

    expect(new Set(results).size).toBe(20);
    expect([...results].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it("rolls back the number when the booking transaction throws (BFL: unbroken series)", async () => {
    const series = await service.createSeries({ code: "A", name: "Manuella verifikat" });
    const year = await makeFiscalYear("2026", "2026-01-01", "2026-12-31");

    await expect(
      db.transaction(async (tx) => {
        await allocateVerificationNumber(tx, series.id, year.id);
        throw new Error("booking failed");
      })
    ).rejects.toThrow("booking failed");

    const next = await db.transaction((tx) => allocateVerificationNumber(tx, series.id, year.id));
    expect(next).toBe(1);
  });
});
