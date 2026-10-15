import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@navet/db";
import { createAtfTransactionSchema } from "@navet/shared";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createTimeReportRepository } from "../src/modules/timereport/repository/timereport.repository.js";
import { EmployeeNotFoundError } from "../src/modules/timereport/service/timereport.service.js";
import { createAtfRepository } from "../src/modules/timereport/repository/atf.repository.js";
import {
  AtfTransactionNotFoundError,
  completedAtfWeeks,
  createAtfService,
} from "../src/modules/timereport/service/atf.service.js";
import { PayrollPeriodLockedError } from "../src/modules/payroll/service/period-lock.js";

const timeReportRepo = createTimeReportRepository(db);

// Stubbed settings reader — the system default rate is flipped per test.
let systemAtfMinutesPerWeek = 0;
// Mutable period-lock stub, same trick — the real payroll_periods-backed
// checker is exercised in payroll-attest.test.ts.
let dateLocked = false;
const service = createAtfService(
  createAtfRepository(db),
  timeReportRepo,
  { getSettings: async () => ({ atfMinutesPerWeek: systemAtfMinutesPerWeek }) },
  { isDateLocked: async () => dateLocked }
);

const TRUNCATE = sql`TRUNCATE atf_transactions, employees CASCADE`;

beforeEach(async () => {
  systemAtfMinutesPerWeek = 0;
  dateLocked = false;
  await db.execute(TRUNCATE);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

async function makeEmployee(atf: { atfMode?: "bank" | "weekly"; atfMinutesPerWeek?: number | null; atfStartDate?: string | null } = {}) {
  const employee = await timeReportRepo.createEmployee({
    employeeNumber: `E-${crypto.randomUUID().slice(0, 8)}`,
    name: "ATF-testare",
    active: true,
  });
  if (Object.keys(atf).length === 0) return employee;
  return (await timeReportRepo.updateEmployee(employee.id, atf))!;
}

const authRepo = createAuthRepository(db);
async function makeUserId(): Promise<string> {
  const user = await authRepo.create({
    email: `atf-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "ATF",
    role: "admin",
  });
  return user.id;
}

describe("completedAtfWeeks", () => {
  it("only counts whole Mon–Sun weeks after the start date", () => {
    // Start Wednesday 2026-06-03 → first counted week begins Monday 2026-06-08.
    expect(completedAtfWeeks("2026-06-03", "2026-06-15")).toBe(1); // week 8–14 June completed
    expect(completedAtfWeeks("2026-06-03", "2026-06-14")).toBe(0); // its Sunday (14th) not yet passed
    // Start on a Monday counts that same week once it has passed.
    expect(completedAtfWeeks("2026-06-08", "2026-06-15")).toBe(1);
    expect(completedAtfWeeks("2026-06-08", "2026-06-22")).toBe(2);
    // The current (incomplete) week never counts.
    expect(completedAtfWeeks("2026-06-08", "2026-06-18")).toBe(1);
    // Start in the future → nothing.
    expect(completedAtfWeeks("2026-07-01", "2026-06-15")).toBe(0);
  });
});

describe("ATF status (saldo)", () => {
  it("uses the employee rate when set, otherwise the system default", async () => {
    systemAtfMinutesPerWeek = 82;
    // 4 completed weeks: start Monday 2026-06-01, asOf Monday 2026-06-29.
    const followsSystem = await makeEmployee({ atfStartDate: "2026-06-01" });
    const hasOverride = await makeEmployee({ atfStartDate: "2026-06-01", atfMinutesPerWeek: 100 });
    const zeroOverride = await makeEmployee({ atfStartDate: "2026-06-01", atfMinutesPerWeek: 0 });

    const system = await service.getAtfStatus(followsSystem.id, "2026-06-29");
    expect(system).toMatchObject({ effectiveMinutesPerWeek: 82, source: "system", accruedMinutes: 328, balanceMinutes: 328 });

    const override = await service.getAtfStatus(hasOverride.id, "2026-06-29");
    expect(override).toMatchObject({ effectiveMinutesPerWeek: 100, source: "employee", accruedMinutes: 400 });

    const zero = await service.getAtfStatus(zeroOverride.id, "2026-06-29");
    expect(zero).toMatchObject({ effectiveMinutesPerWeek: 0, source: "employee", accruedMinutes: 0 });
  });

  it("accrues nothing without a start date, and not into the balance in weekly mode", async () => {
    systemAtfMinutesPerWeek = 82;
    const noStart = await makeEmployee();
    expect(await service.getAtfStatus(noStart.id, "2026-06-29")).toMatchObject({ accruedMinutes: 0, balanceMinutes: 0 });

    const weekly = await makeEmployee({ atfMode: "weekly", atfStartDate: "2026-06-01" });
    const status = await service.getAtfStatus(weekly.id, "2026-06-29");
    expect(status).toMatchObject({ mode: "weekly", accruedMinutes: 0, balanceMinutes: 0 });
  });

  it("subtracts withdrawals, adds signed adjustments and allows a negative balance", async () => {
    systemAtfMinutesPerWeek = 60;
    const employee = await makeEmployee({ atfStartDate: "2026-06-01" });
    const userId = await makeUserId();

    // Ingående saldo +120, uttag 240 → 4 weeks × 60 + 120 − 240 = 120.
    await service.createAtfTransaction(employee.id, { date: "2026-06-01", type: "adjustment", minutes: 120, note: "Ingående saldo" }, userId);
    await service.createAtfTransaction(employee.id, { date: "2026-06-26", type: "withdrawal", minutes: 240 }, userId);

    const status = await service.getAtfStatus(employee.id, "2026-06-29");
    expect(status).toMatchObject({ accruedMinutes: 240, withdrawnMinutes: 240, adjustedMinutes: 120, balanceMinutes: 120 });
    expect(status.transactions).toHaveLength(2);

    // Another withdrawal pushes the balance negative — allowed (förskott).
    await service.createAtfTransaction(employee.id, { date: "2026-06-27", type: "withdrawal", minutes: 300 }, userId);
    expect((await service.getAtfStatus(employee.id, "2026-06-29")).balanceMinutes).toBe(-180);
  });

  it("validates transactions via zod and 404s on unknown ids", async () => {
    expect(() => createAtfTransactionSchema.parse({ date: "2026-06-26", type: "withdrawal", minutes: 0 })).toThrow();
    expect(() => createAtfTransactionSchema.parse({ date: "2026-06-26", type: "withdrawal", minutes: -60 })).toThrow();
    expect(() => createAtfTransactionSchema.parse({ date: "2026-06-26", type: "adjustment", minutes: 0 })).toThrow();
    expect(createAtfTransactionSchema.parse({ date: "2026-06-26", type: "adjustment", minutes: -60 }).minutes).toBe(-60);

    const employee = await makeEmployee();
    const userId = await makeUserId();
    await expect(
      service.createAtfTransaction(crypto.randomUUID(), { date: "2026-06-26", type: "withdrawal", minutes: 60 }, userId)
    ).rejects.toBeInstanceOf(EmployeeNotFoundError);
    await expect(service.deleteAtfTransaction(employee.id, crypto.randomUUID())).rejects.toBeInstanceOf(
      AtfTransactionNotFoundError
    );

    const tx = await service.createAtfTransaction(employee.id, { date: "2026-06-26", type: "withdrawal", minutes: 60 }, userId);
    await service.deleteAtfTransaction(employee.id, tx.id);
    expect((await service.getAtfStatus(employee.id, "2026-06-29")).transactions).toHaveLength(0);
  });

  it("rejects creating or deleting a transaction dated inside a locked payroll period", async () => {
    const employee = await makeEmployee();
    const userId = await makeUserId();
    const tx = await service.createAtfTransaction(
      employee.id,
      { date: "2026-06-26", type: "withdrawal", minutes: 60 },
      userId
    );

    dateLocked = true;
    await expect(
      service.createAtfTransaction(employee.id, { date: "2026-06-27", type: "withdrawal", minutes: 60 }, userId)
    ).rejects.toBeInstanceOf(PayrollPeriodLockedError);
    await expect(service.deleteAtfTransaction(employee.id, tx.id)).rejects.toBeInstanceOf(PayrollPeriodLockedError);

    // A missing transaction still 404s rather than reporting the lock.
    await expect(service.deleteAtfTransaction(employee.id, crypto.randomUUID())).rejects.toBeInstanceOf(
      AtfTransactionNotFoundError
    );
  });
});
