import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { auditLog, db, fiscalYears } from "@navet/db";
import { createFiscalYearSchema, unlockPeriodSchema } from "@navet/shared";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createEconomyRepository } from "../src/modules/economy/repository/economy.repository.js";
import {
  AccountingPeriodNotFoundError,
  DuplicateFiscalYearLabelError,
  FiscalYearBeforeClosedYearError,
  FiscalYearNotFoundError,
  OverlappingFiscalYearError,
  PeriodAlreadyLockedError,
  PeriodNotLockedError,
  createEconomyService,
} from "../src/modules/economy/service/economy.service.js";
import { generateMonthlyPeriods } from "../src/modules/economy/service/month-periods.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";

const repo = createEconomyRepository(db);
const auditRepository = createAuditRepository(db);
const authRepo = createAuthRepository(db);
const service = createEconomyService(repo, auditRepository);

const TRUNCATE = sql`TRUNCATE accounting_periods, fiscal_years, audit_log, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

async function makeUser(name = "Ekonomiadmin") {
  return authRepo.create({
    email: `economy-fiscal-years-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name,
    role: "admin",
  });
}

async function auditRows(entityType: string, action: string) {
  return db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entityType, entityType), eq(auditLog.action, action)));
}

// Pure function — no DB round-trip needed to verify the month-clipping rules.
describe("generateMonthlyPeriods (pure)", () => {
  it("splits a calendar year into 12 unclipped monthly periods", () => {
    const periods = generateMonthlyPeriods("2026-01-01", "2026-12-31");
    expect(periods).toHaveLength(12);
    expect(periods[0]).toEqual({ startDate: "2026-01-01", endDate: "2026-01-31" });
    expect(periods[11]).toEqual({ startDate: "2026-12-01", endDate: "2026-12-31" });
  });

  it("clips the first and last period of a brutet år to the year's own bounds", () => {
    const periods = generateMonthlyPeriods("2026-05-01", "2027-04-30");
    expect(periods).toHaveLength(12);
    expect(periods[0]).toEqual({ startDate: "2026-05-01", endDate: "2026-05-31" });
    expect(periods[11]).toEqual({ startDate: "2027-04-01", endDate: "2027-04-30" });
  });

  it("generates 6 periods for a short year", () => {
    const periods = generateMonthlyPeriods("2026-07-01", "2026-12-31");
    expect(periods).toHaveLength(6);
    expect(periods[0]).toEqual({ startDate: "2026-07-01", endDate: "2026-07-31" });
    expect(periods[5]).toEqual({ startDate: "2026-12-01", endDate: "2026-12-31" });
  });

  it("clips the first and last period to a fiscal year that doesn't start/end on a month boundary", () => {
    const periods = generateMonthlyPeriods("2026-05-15", "2027-05-14");
    expect(periods).toHaveLength(13);
    expect(periods[0]).toEqual({ startDate: "2026-05-15", endDate: "2026-05-31" });
    expect(periods[periods.length - 1]).toEqual({ startDate: "2027-05-01", endDate: "2027-05-14" });
  });
});

describe("economy service — fiscal years & periods", () => {
  it("rejects endDate <= startDate (zod)", () => {
    expect(
      createFiscalYearSchema.safeParse({ label: "X", startDate: "2026-01-01", endDate: "2026-01-01" }).success
    ).toBe(false);
    expect(
      createFiscalYearSchema.safeParse({ label: "X", startDate: "2026-01-01", endDate: "2026-12-31" }).success
    ).toBe(true);
  });

  it("creates a calendar-year fiscal year with 12 monthly periods", async () => {
    const year = await service.createFiscalYear({ label: "2026", startDate: "2026-01-01", endDate: "2026-12-31" });
    expect(year.periods).toHaveLength(12);
    expect(year.periods[0]).toMatchObject({ startDate: "2026-01-01", endDate: "2026-01-31", status: "open" });
    expect(year.periods[11]).toMatchObject({ startDate: "2026-12-01", endDate: "2026-12-31", status: "open" });

    const listed = await service.listFiscalYears();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ label: "2026", periodCount: 12 });
  });

  it("creates a brutet år with periods clipped to the year's bounds", async () => {
    const year = await service.createFiscalYear({
      label: "2026/2027",
      startDate: "2026-05-01",
      endDate: "2027-04-30",
    });
    expect(year.periods).toHaveLength(12);
    expect(year.periods[0]).toMatchObject({ startDate: "2026-05-01", endDate: "2026-05-31" });
    expect(year.periods[11]).toMatchObject({ startDate: "2027-04-01", endDate: "2027-04-30" });
  });

  it("creates a short year with 6 periods", async () => {
    const year = await service.createFiscalYear({ label: "2026H2", startDate: "2026-07-01", endDate: "2026-12-31" });
    expect(year.periods).toHaveLength(6);
  });

  it("rejects an overlapping fiscal year but allows an edge-to-edge adjacent one", async () => {
    await service.createFiscalYear({ label: "2026", startDate: "2026-01-01", endDate: "2026-12-31" });

    await expect(
      service.createFiscalYear({ label: "overlap", startDate: "2026-06-01", endDate: "2027-05-31" })
    ).rejects.toBeInstanceOf(OverlappingFiscalYearError);

    // Edge-to-edge: new start = existing end + 1 day is fine, not an overlap.
    const next = await service.createFiscalYear({ label: "2027", startDate: "2027-01-01", endDate: "2027-12-31" });
    expect(next.periods).toHaveLength(12);
  });

  it("refuses a fiscal year before a closed one but allows one after it", async () => {
    const closed = await service.createFiscalYear({ label: "2026", startDate: "2026-01-01", endDate: "2026-12-31" });
    await db.update(fiscalYears).set({ status: "closed", closedAt: new Date() }).where(eq(fiscalYears.id, closed.id));

    await expect(
      service.createFiscalYear({ label: "2025", startDate: "2025-01-01", endDate: "2025-12-31" })
    ).rejects.toBeInstanceOf(FiscalYearBeforeClosedYearError);
    expect(await service.listFiscalYears()).toHaveLength(1);

    const after = await service.createFiscalYear({ label: "2027", startDate: "2027-01-01", endDate: "2027-12-31" });
    expect(after.periods).toHaveLength(12);
  });

  it("rejects a duplicate fiscal year label even with non-overlapping dates (DuplicateFiscalYearLabelError, 409 — not a raw 500 from the DB's unique constraint)", async () => {
    await service.createFiscalYear({ label: "2026", startDate: "2026-01-01", endDate: "2026-12-31" });

    await expect(
      service.createFiscalYear({ label: "2026", startDate: "2030-01-01", endDate: "2030-12-31" })
    ).rejects.toBeInstanceOf(DuplicateFiscalYearLabelError);
  });

  it("throws FiscalYearNotFoundError for a missing id", async () => {
    await expect(service.findFiscalYearById("00000000-0000-0000-0000-000000000000")).rejects.toBeInstanceOf(
      FiscalYearNotFoundError
    );
  });

  it("resolves the fiscal year/period/status covering a date, and null outside any year", async () => {
    await service.createFiscalYear({ label: "2026", startDate: "2026-01-01", endDate: "2026-12-31" });

    expect(await repo.getPeriodStatusForDate("2026-06-15")).toBe("open");
    expect(await repo.getPeriodStatusForDate("2025-06-15")).toBeNull();

    const periodForDate = await repo.findPeriodForDate("2026-06-15");
    expect(periodForDate).toMatchObject({ startDate: "2026-06-01", endDate: "2026-06-30" });
    expect(await repo.findPeriodForDate("2025-06-15")).toBeNull();

    const yearForDate = await repo.findFiscalYearForDate("2026-06-15");
    expect(yearForDate).toMatchObject({ label: "2026" });
    expect(await repo.findFiscalYearForDate("2025-06-15")).toBeNull();
  });

  it("locks a period (status + audit row) and rejects locking it again", async () => {
    const user = await makeUser();
    const year = await service.createFiscalYear({ label: "2026", startDate: "2026-01-01", endDate: "2026-12-31" });
    const period = year.periods[0]!;

    const locked = await service.lockPeriod(period.id, user.id);
    expect(locked.status).toBe("locked");
    expect(locked.lockedBy).toBe(user.id);
    expect(locked.lockedAt).not.toBeNull();

    const rows = await auditRows("accounting_period", "locked");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entityId: "2026-2026-01", userId: user.id });

    expect(await repo.getPeriodStatusForDate("2026-01-15")).toBe("locked");

    await expect(service.lockPeriod(period.id, user.id)).rejects.toBeInstanceOf(PeriodAlreadyLockedError);
  });

  it("throws AccountingPeriodNotFoundError when locking a missing period", async () => {
    const user = await makeUser();
    await expect(service.lockPeriod("00000000-0000-0000-0000-000000000000", user.id)).rejects.toBeInstanceOf(
      AccountingPeriodNotFoundError
    );
  });

  it("rejects unlocking without a reason (zod)", () => {
    expect(unlockPeriodSchema.safeParse({}).success).toBe(false);
    expect(unlockPeriodSchema.safeParse({ reason: "kort" }).success).toBe(false);
    expect(unlockPeriodSchema.safeParse({ reason: "Rättelse av felbokning" }).success).toBe(true);
  });

  it("unlocks a locked period with a reason (status + audit row with reason in detail)", async () => {
    const user = await makeUser();
    const year = await service.createFiscalYear({ label: "2026", startDate: "2026-01-01", endDate: "2026-12-31" });
    const period = year.periods[0]!;
    await service.lockPeriod(period.id, user.id);

    const unlocked = await service.unlockPeriod(period.id, "Rättelse av felbokning", user.id);
    expect(unlocked.status).toBe("open");
    expect(unlocked.lockedAt).toBeNull();
    expect(unlocked.lockedBy).toBeNull();

    const rows = await auditRows("accounting_period", "unlocked");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      entityId: "2026-2026-01",
      userId: user.id,
      detail: { reason: "Rättelse av felbokning" },
    });
  });

  it("rejects unlocking a period that is not locked", async () => {
    const user = await makeUser();
    const year = await service.createFiscalYear({ label: "2026", startDate: "2026-01-01", endDate: "2026-12-31" });
    const period = year.periods[0]!;

    await expect(service.unlockPeriod(period.id, "Test", user.id)).rejects.toBeInstanceOf(PeriodNotLockedError);
  });
});
