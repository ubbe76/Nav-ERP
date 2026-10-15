import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { auditLog, db, overtimeDispositions } from "@navet/db";
import { PAXML_CODES } from "./helpers/services.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { createPayrollRepository } from "../src/modules/payroll/repository/payroll.repository.js";
import {
  createPayrollService,
  OvertimeDispositionNotFoundError,
} from "../src/modules/payroll/service/payroll.service.js";
import { PayrollPeriodLockedError } from "../src/modules/payroll/service/period-lock.js";
import { createTimeReportRepository } from "../src/modules/timereport/repository/timereport.repository.js";
import { EmployeeNotFoundError } from "../src/modules/timereport/service/timereport.service.js";

const payrollRepository = createPayrollRepository(db);
const timeReportRepository = createTimeReportRepository(db);
const authRepo = createAuthRepository(db);

let dateLocked = false;
const service = createPayrollService(
  payrollRepository,
  timeReportRepository,
  { isDateLocked: async () => dateLocked },
  { resolveEmployeeCalendar: async () => [], listHolidaysInRange: async () => [] },
  { listAttendanceSessionsInRange: async () => [] },
  { listWithdrawalsInRange: async () => [] },
  { getSettings: async () => ({ payrollOvertimeThresholdMinutes: 0, ...PAXML_CODES }) },
  createAuditRepository(db),
  { getCompanyInfo: async () => null },
  { renderPayrollReport: async () => Buffer.from("") }
);

const TRUNCATE = sql`TRUNCATE overtime_dispositions, audit_log, employees, users CASCADE`;

beforeEach(async () => {
  dateLocked = false;
  await db.execute(TRUNCATE);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

async function makeUser() {
  return authRepo.create({
    email: `disposition-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Arbetsledare",
    role: "supervisor",
  });
}

async function makeEmployee() {
  return timeReportRepository.createEmployee({
    employeeNumber: `E-${crypto.randomUUID().slice(0, 8)}`,
    name: "Anställd",
    active: true,
  });
}

describe("setOvertimeDisposition / clearOvertimeDisposition", () => {
  it("stores an explicit choice even when it equals the employee default", async () => {
    const user = await makeUser();
    const employee = await makeEmployee(); // default overtime_compensation = payout
    const row = await service.setOvertimeDisposition(employee.id, "2026-06-03", "payout", user.id);
    expect(row.disposition).toBe("payout");
    const stored = await db.select().from(overtimeDispositions).where(eq(overtimeDispositions.employeeId, employee.id));
    expect(stored).toHaveLength(1);
  });

  it("upserts: a second set on the same day replaces the disposition", async () => {
    const user = await makeUser();
    const employee = await makeEmployee();
    await service.setOvertimeDisposition(employee.id, "2026-06-03", "comp", user.id);
    const row = await service.setOvertimeDisposition(employee.id, "2026-06-03", "payout", user.id);
    expect(row.disposition).toBe("payout");
    const stored = await db.select().from(overtimeDispositions).where(eq(overtimeDispositions.employeeId, employee.id));
    expect(stored).toHaveLength(1);
  });

  it("clears an override and 404s when none exists", async () => {
    const user = await makeUser();
    const employee = await makeEmployee();
    await service.setOvertimeDisposition(employee.id, "2026-06-03", "comp", user.id);
    await service.clearOvertimeDisposition(employee.id, "2026-06-03", user.id);
    const stored = await db.select().from(overtimeDispositions).where(eq(overtimeDispositions.employeeId, employee.id));
    expect(stored).toHaveLength(0);
    await expect(service.clearOvertimeDisposition(employee.id, "2026-06-03", user.id)).rejects.toBeInstanceOf(
      OvertimeDispositionNotFoundError
    );
  });

  it("rejects both writes when the period is locked", async () => {
    const user = await makeUser();
    const employee = await makeEmployee();
    await service.setOvertimeDisposition(employee.id, "2026-06-03", "comp", user.id);
    dateLocked = true;
    await expect(service.setOvertimeDisposition(employee.id, "2026-06-04", "comp", user.id)).rejects.toBeInstanceOf(
      PayrollPeriodLockedError
    );
    await expect(service.clearOvertimeDisposition(employee.id, "2026-06-03", user.id)).rejects.toBeInstanceOf(
      PayrollPeriodLockedError
    );
  });

  it("rejects an unknown employee", async () => {
    const user = await makeUser();
    await expect(
      service.setOvertimeDisposition(crypto.randomUUID(), "2026-06-03", "comp", user.id)
    ).rejects.toBeInstanceOf(EmployeeNotFoundError);
  });

  it("writes audit entries for set and clear", async () => {
    const user = await makeUser();
    const employee = await makeEmployee();
    await service.setOvertimeDisposition(employee.id, "2026-06-03", "comp", user.id);
    await service.clearOvertimeDisposition(employee.id, "2026-06-03", user.id);
    const entries = await db.select().from(auditLog).where(eq(auditLog.entityType, "overtime_disposition"));
    expect(entries.map((e) => e.action).sort()).toEqual(["cleared", "set"]);
  });
});
