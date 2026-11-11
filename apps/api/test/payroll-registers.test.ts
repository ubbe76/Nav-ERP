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

// The same service whose pre-checks never see a duplicate — what the loser of
// two simultaneous saves sees: both pass the checks, the constraint decides.
const realRepo = createPayrollRepository(db);
const racingService = createPayrollService(
  {
    ...realRepo,
    findAbsenceTypeByCode: async () => null,
    findAbsenceTypeByName: async () => null,
    findObRuleByCode: async () => null,
    findObRuleByName: async () => null,
  },
  createTimeReportRepository(db),
  { isDateLocked: async () => false },
  { resolveEmployeeCalendar: async () => [], listHolidaysInRange: async () => [] },
  { listAttendanceSessionsInRange: async () => [] },
  { listWithdrawalsInRange: async () => [] },
  { getSettings: async () => ({ payrollOvertimeThresholdMinutes: 0, ...PAXML_CODES }) },
  { log: async () => {} },
  { getCompanyInfo: async () => null },
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

  it("maps a duplicate that slips past the pre-checks (two saves at once) to the 409, not a 500", async () => {
    await service.createAbsenceType({ code: "SJK", name: "Sjukfrånvaro", paxmlCode: "SJK" });
    const other = await service.createAbsenceType({ code: "VAB", name: "Vård av barn", paxmlCode: "VAB" });
    await expect(racingService.createAbsenceType({ code: "SJK", name: "Annat", paxmlCode: "SJK" })).rejects.toThrow(
      DuplicatePayrollCodeError
    );
    await expect(racingService.createAbsenceType({ code: "XYZ", name: "Sjukfrånvaro", paxmlCode: "XYZ" })).rejects.toThrow(
      DuplicatePayrollCodeError
    );
    await expect(racingService.updateAbsenceType(other.id, { code: "SJK" })).rejects.toThrow(DuplicatePayrollCodeError);

    const rule = await service.createObRule({ code: "OB1", name: "Kväll", dayKind: "weekday", startTime: "18:00", endTime: "22:00", paxmlCode: "OB1" });
    const second = await service.createObRule({ code: "OB2", name: "Natt", dayKind: "weekday", startTime: "22:00", endTime: "00:00", paxmlCode: "OB2" });
    await expect(
      racingService.createObRule({ code: "OB1", name: "Annan", dayKind: "weekday", startTime: "18:00", endTime: "22:00", paxmlCode: "OB1" })
    ).rejects.toThrow(DuplicatePayrollCodeError);
    await expect(racingService.updateObRule(second.id, { code: rule.code })).rejects.toThrow(DuplicatePayrollCodeError);
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

  // Natt-OB as 22:00–00:00: the end 00:00 is midnight (it was refused as
  // "not after the start", so the window had to stop at 23:59).
  it("accepts an end time of 00:00 as midnight, and 00:00–00:00 as the whole day", async () => {
    const night = await service.createObRule({ code: "OBN", name: "Natt", dayKind: "weekday", startTime: "22:00", endTime: "00:00", paxmlCode: "OBN" });
    expect(night.endTime).toBe("00:00");
    const day = await service.createObRule({ code: "OBS", name: "Söndag", dayKind: "sunday", startTime: "00:00", endTime: "00:00", paxmlCode: "OBS" });
    expect(day.startTime).toBe("00:00");
    // Changing only the start keeps the stored 00:00 end valid.
    expect((await service.updateObRule(night.id, { startTime: "21:00" })).startTime).toBe("21:00");
  });
});
