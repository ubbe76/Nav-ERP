import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@navet/db";
import { PAXML_CODES } from "./helpers/services.js";
import { createPayrollRepository } from "../src/modules/payroll/repository/payroll.repository.js";
import {
  createPayrollService,
  DuplicatePayrollCodeError,
  InvalidObWindowError,
} from "../src/modules/payroll/service/payroll.service.js";
import { createTimeReportRepository } from "../src/modules/timereport/repository/timereport.repository.js";

// Registers-only tests, so the employee reader, period-lock checker and
// period-summary collaborators are never exercised here (see
// payroll-absence.test.ts / payroll-summary.test.ts for those) — wired with
// the same real repository + always-open/no-op stubs as app.ts, kept as a
// module-scope singleton to match register.service.test.ts's structure.
const service = createPayrollService(
  createPayrollRepository(db),
  createTimeReportRepository(db),
  { isDateLocked: async () => false },
  { resolveEmployeeCalendar: async () => [], listHolidaysInRange: async () => [] },
  { listAttendanceSessionsInRange: async () => [] },
  { listWithdrawalsInRange: async () => [] },
  { getSettings: async () => ({ payrollOvertimeThresholdMinutes: 0, ...PAXML_CODES }) },
  { log: async () => {} },
  // Only the exports read the company header — see payroll-export.test.ts.
  { getCompanyInfo: async () => null },
  // The PDF report has its own coverage in payroll-pdf.test.ts (with the
  // real renderer) — a stub keeps this file focused on the registers.
  { renderPayrollReport: async () => Buffer.from("") }
);

beforeEach(async () => {
  await db.execute(sql`TRUNCATE absences, absence_types, ob_rules CASCADE`);
});

afterAll(async () => {
  await db.execute(sql`TRUNCATE absences, absence_types, ob_rules CASCADE`);
});

describe("payroll service — absence types", () => {
  it("creates and lists absence types", async () => {
    await service.createAbsenceType({ code: "SJK", name: "Sjukfrånvaro", paxmlCode: "SJK" });
    const types = await service.listAbsenceTypes();
    expect(types.map((t) => t.code)).toContain("SJK");
  });

  it("rejects duplicate absence type code", async () => {
    await service.createAbsenceType({ code: "SJK", name: "Sjukfrånvaro", paxmlCode: "SJK" });
    await expect(
      service.createAbsenceType({ code: "SJK", name: "Annat namn", paxmlCode: "SJK" })
    ).rejects.toThrow(DuplicatePayrollCodeError);
  });

  it("seedStandardAbsenceTypes is idempotent", async () => {
    const first = await service.seedStandardAbsenceTypes();
    expect(first.created).toBeGreaterThan(0);
    const second = await service.seedStandardAbsenceTypes();
    expect(second.created).toBe(0);
    expect(second.skipped).toBe(first.created);
  });

  it("seeds sjuk, VAB, föräldraledig and tjänstledig as not earning ATF", async () => {
    await service.seedStandardAbsenceTypes();
    const types = await service.listAbsenceTypes();
    const notEarning = types.filter((t) => !t.earnsAtf).map((t) => t.code).sort();
    expect(notEarning).toEqual(["FPE", "SJK", "TJL", "VAB"]);
    expect(types.find((t) => t.code === "SEM")?.earnsAtf).toBe(true);
  });

  it("Tjänar in ATF defaults on and can be changed", async () => {
    const type = await service.createAbsenceType({ code: "UTB", name: "Utbildning", paxmlCode: "UTB" });
    expect(type.earnsAtf).toBe(true);
    const updated = await service.updateAbsenceType(type.id, { earnsAtf: false });
    expect(updated.earnsAtf).toBe(false);
  });

  it("listAbsenceTypes hides inactive unless includeInactive", async () => {
    const sjk = await service.createAbsenceType({ code: "SJK", name: "Sjukfrånvaro", paxmlCode: "SJK" });
    await service.updateAbsenceType(sjk.id, { active: false });

    expect(await service.listAbsenceTypes()).toEqual([]);
    const withInactive = await service.listAbsenceTypes(true);
    expect(withInactive.map((t) => t.id)).toContain(sjk.id);
  });
});

describe("payroll service — OB rules", () => {
  it("creates an OB rule and rejects end <= start", async () => {
    const rule = await service.createObRule({
      code: "OB1",
      name: "Kväll vardag",
      dayKind: "weekday",
      startTime: "18:00",
      endTime: "22:00",
      paxmlCode: "OB1",
    });
    expect(rule.code).toBe("OB1");
    expect(rule.startTime).toBe("18:00");
    expect(rule.endTime).toBe("22:00");

    await expect(
      service.createObRule({
        code: "OB2",
        name: "Natt",
        dayKind: "weekday",
        startTime: "22:00",
        endTime: "06:00",
        paxmlCode: "OB2",
      })
    ).rejects.toThrow(InvalidObWindowError);
  });
});
