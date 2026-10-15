import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@navet/db";
import { PAXML_CODES } from "./helpers/services.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createPayrollRepository } from "../src/modules/payroll/repository/payroll.repository.js";
import {
  AbsenceNotFoundError,
  createPayrollService,
  DuplicateAbsenceError,
  InactiveAbsenceTypeError,
} from "../src/modules/payroll/service/payroll.service.js";
import { PayrollPeriodLockedError } from "../src/modules/payroll/service/period-lock.js";
import { createTimeReportRepository } from "../src/modules/timereport/repository/timereport.repository.js";
import { EmployeeNotFoundError } from "../src/modules/timereport/service/timereport.service.js";

const payrollRepository = createPayrollRepository(db);
const timeReportRepository = createTimeReportRepository(db);
const authRepo = createAuthRepository(db);

// Mutable stub so a single test can flip period-locking on, same trick as
// schedule.service.test.ts's dateLocked.
let dateLocked = false;
// This file only exercises absence bookings, never the period summary — the
// schedule/attendance/atf/settings collaborators are stubbed out with
// never-called-in-practice no-ops (see payroll-summary.test.ts for the real
// wiring).
const service = createPayrollService(
  payrollRepository,
  timeReportRepository,
  { isDateLocked: async () => dateLocked },
  { resolveEmployeeCalendar: async () => [], listHolidaysInRange: async () => [] },
  { listAttendanceSessionsInRange: async () => [] },
  { listWithdrawalsInRange: async () => [] },
  { getSettings: async () => ({ payrollOvertimeThresholdMinutes: 0, ...PAXML_CODES }) },
  // The audit trail has its own coverage in payroll-attest.test.ts (real
  // repository against the DB) — a no-op writer keeps this file focused.
  { log: async () => {} },
  // Only the exports read the company header — see payroll-export.test.ts.
  { getCompanyInfo: async () => null },
  // The PDF report has its own coverage in payroll-pdf.test.ts (with the
  // real renderer) — a stub keeps this file focused on absence bookings.
  { renderPayrollReport: async () => Buffer.from("") }
);

beforeEach(async () => {
  dateLocked = false;
  await db.execute(sql`TRUNCATE absences, absence_types, ob_rules, employees, users CASCADE`);
});

afterAll(async () => {
  await db.execute(sql`TRUNCATE absences, absence_types, ob_rules, employees, users CASCADE`);
});

async function makeEmployee() {
  return timeReportRepository.createEmployee({
    employeeNumber: `E-${crypto.randomUUID().slice(0, 8)}`,
    name: "Anställd",
    active: true,
  });
}

async function makeUser() {
  return authRepo.create({
    email: `absence-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Löneadmin",
    role: "admin",
  });
}

async function makeAbsenceType(overrides: Partial<{ code: string; name: string; paxmlCode: string }> = {}) {
  return payrollRepository.createAbsenceType({
    code: overrides.code ?? "SJK",
    name: overrides.name ?? "Sjukfrånvaro",
    paxmlCode: overrides.paxmlCode ?? "SJK",
  });
}

describe("payroll service — absences", () => {
  it("creates and lists absences for an employee, with a from/to filter", async () => {
    const employee = await makeEmployee();
    const user = await makeUser();
    const type = await makeAbsenceType();

    await service.createAbsence(employee.id, { absenceTypeId: type.id, date: "2026-07-10", minutes: 480 }, user.id);
    await service.createAbsence(employee.id, { absenceTypeId: type.id, date: "2026-08-10", minutes: 240 }, user.id);

    const all = await service.listEmployeeAbsences(employee.id);
    expect(all).toHaveLength(2);
    expect(all[0]!.date).toBe("2026-08-10"); // ordered by date desc
    expect(all[0]!.absenceTypeCode).toBe("SJK");
    expect(all[0]!.absenceTypeName).toBe("Sjukfrånvaro");

    const filtered = await service.listEmployeeAbsences(employee.id, "2026-07-01", "2026-07-31");
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.date).toBe("2026-07-10");
  });

  it("throws EmployeeNotFoundError for an unknown employee", async () => {
    const user = await makeUser();
    const type = await makeAbsenceType();

    await expect(
      service.createAbsence(
        crypto.randomUUID(),
        { absenceTypeId: type.id, date: "2026-07-10", minutes: 480 },
        user.id
      )
    ).rejects.toBeInstanceOf(EmployeeNotFoundError);
  });

  it("throws InactiveAbsenceTypeError for an inactive absence type", async () => {
    const employee = await makeEmployee();
    const user = await makeUser();
    const type = await makeAbsenceType({ code: "SEM", name: "Semester", paxmlCode: "SEM" });
    await payrollRepository.updateAbsenceType(type.id, { active: false });

    await expect(
      service.createAbsence(employee.id, { absenceTypeId: type.id, date: "2026-07-10", minutes: 480 }, user.id)
    ).rejects.toBeInstanceOf(InactiveAbsenceTypeError);
  });

  it("rejects a duplicate employee+date+type but allows two types the same day", async () => {
    const employee = await makeEmployee();
    const user = await makeUser();
    const sick = await makeAbsenceType({ code: "SJK", name: "Sjukfrånvaro", paxmlCode: "SJK" });
    const vab = await makeAbsenceType({ code: "VAB", name: "Vård av barn", paxmlCode: "VAB" });

    await service.createAbsence(employee.id, { absenceTypeId: sick.id, date: "2026-07-10", minutes: 240 }, user.id);

    await expect(
      service.createAbsence(employee.id, { absenceTypeId: sick.id, date: "2026-07-10", minutes: 240 }, user.id)
    ).rejects.toBeInstanceOf(DuplicateAbsenceError);

    const other = await service.createAbsence(
      employee.id,
      { absenceTypeId: vab.id, date: "2026-07-10", minutes: 240 },
      user.id
    );
    expect(other.absenceTypeId).toBe(vab.id);

    expect(await service.listEmployeeAbsences(employee.id)).toHaveLength(2);
  });

  it("deletes an absence", async () => {
    const employee = await makeEmployee();
    const user = await makeUser();
    const type = await makeAbsenceType();

    const absence = await service.createAbsence(
      employee.id,
      { absenceTypeId: type.id, date: "2026-07-10", minutes: 480 },
      user.id
    );

    await service.deleteAbsence(absence.id, user.id);

    await expect(service.deleteAbsence(absence.id, user.id)).rejects.toBeInstanceOf(AbsenceNotFoundError);
    expect(await service.listEmployeeAbsences(employee.id)).toHaveLength(0);
  });

  it("rejects create and delete when the period-lock stub reports the date as locked", async () => {
    const employee = await makeEmployee();
    const user = await makeUser();
    const type = await makeAbsenceType();

    dateLocked = true;
    await expect(
      service.createAbsence(employee.id, { absenceTypeId: type.id, date: "2026-07-10", minutes: 480 }, user.id)
    ).rejects.toBeInstanceOf(PayrollPeriodLockedError);

    dateLocked = false;
    const absence = await service.createAbsence(
      employee.id,
      { absenceTypeId: type.id, date: "2026-07-10", minutes: 480 },
      user.id
    );

    dateLocked = true;
    await expect(service.deleteAbsence(absence.id, user.id)).rejects.toBeInstanceOf(PayrollPeriodLockedError);
  });
});
