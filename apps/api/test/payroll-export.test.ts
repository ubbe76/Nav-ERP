import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { auditLog, db } from "@navet/db";
import { testArticleService, testDocumentPdfService } from "./helpers/services.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { createPayrollRepository } from "../src/modules/payroll/repository/payroll.repository.js";
import {
  PeriodNotLockedError,
  createPayrollService,
  type PayrollDay,
  type PeriodEmployeeSummary,
  type PeriodSummary,
} from "../src/modules/payroll/service/payroll.service.js";
import { buildPaxmlXml, xmlEscape, type PaxmlInput } from "../src/modules/payroll/service/paxml.js";
import { buildPayrollCsv } from "../src/modules/payroll/service/payroll-csv.js";
import { createPeriodLockChecker } from "../src/modules/payroll/service/period-lock.js";
import { createAtfRepository } from "../src/modules/timereport/repository/atf.repository.js";
import { createScheduleRepository } from "../src/modules/timereport/repository/schedule.repository.js";
import { createScheduleService } from "../src/modules/timereport/service/schedule.service.js";
import { createTimeReportRepository } from "../src/modules/timereport/repository/timereport.repository.js";

// ---------------------------------------------------------------------------
// Pure builders (no DB) — the PAXml/CSV knowledge lives entirely in these two
// modules, so they carry the bulk of the coverage.
// ---------------------------------------------------------------------------

// Fixed company so the header assertions are deterministic.
const COMPANY = { name: "Navet & Söner AB", orgNumber: "556000-0000" };

function paxmlInput(overrides: Partial<PaxmlInput> = {}): PaxmlInput {
  return {
    orgNo: COMPANY.orgNumber,
    companyName: COMPANY.name,
    exportDate: "2026-07-26T08:30:00.000Z",
    employees: [
      {
        employeeNumber: "101",
        personalIdentityNumber: "19800101-1234",
        days: [
          {
            date: "2026-06-02",
            posts: [
              { code: "TID", hours: 8 },
              { code: "ÖT1", hours: 1.5 },
            ],
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe("xmlEscape", () => {
  it("escapes the five XML entities", () => {
    expect(xmlEscape(`Ove & "Kalle" <b> 'x'`)).toBe("Ove &amp; &quot;Kalle&quot; &lt;b&gt; &apos;x&apos;");
  });

  it("escapes ampersands before the other entities (no double escaping)", () => {
    expect(xmlEscape("A & <B>")).toBe("A &amp; &lt;B&gt;");
    expect(xmlEscape("&amp;")).toBe("&amp;amp;");
  });

  it("leaves Swedish characters untouched", () => {
    expect(xmlEscape("Åsa Öberg-Ängström")).toBe("Åsa Öberg-Ängström");
  });

  it("strips control characters illegal in XML 1.0 but keeps tab/LF/CR", () => {
    // \x01 (SOH) and \x1F are illegal in an XML 1.0 document and would
    // otherwise produce an unparseable export if they leaked in through a
    // free-text field (e.g. a manually-entered code or note).
    expect(xmlEscape("A\x01B\x1FC")).toBe("ABC");
    expect(xmlEscape("A\tB\nC\rD")).toBe("A\tB\nC\rD");
  });
});

describe("buildPaxmlXml", () => {
  it("emits the XML declaration and the PAXml 2.2 root with the schema reference", () => {
    const xml = buildPaxmlXml(paxmlInput());
    // The spec requires the noNamespaceSchemaLocation reference for the file
    // to be validatable; PAXml has no target namespace.
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain(
      '<paxml xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.paxml.se/2.2/paxml.xsd">'
    );
    expect(xml.trimEnd().endsWith("</paxml>")).toBe(true);
  });

  it("writes the header in schema order with a dateTime export stamp", () => {
    const xml = buildPaxmlXml(paxmlInput());
    expect(xml).toContain("<format>LÖNIN</format>");
    expect(xml).toContain("<version>2.2</version>");
    // header/datum is xs:dateTime in the XSD, not xs:date.
    expect(xml).toContain("<datum>2026-07-26T08:30:00</datum>");
    expect(xml).toContain("<foretagorgnr>556000-0000</foretagorgnr>");
    expect(xml.indexOf("<version>")).toBeLessThan(xml.indexOf("<datum>"));
  });

  it("escapes the company name", () => {
    const xml = buildPaxmlXml(paxmlInput());
    expect(xml).toContain("<foretagnamn>Navet &amp; Söner AB</foretagnamn>");
  });

  it("omits header fields the company has not filled in", () => {
    const xml = buildPaxmlXml(paxmlInput({ orgNo: null, companyName: null }));
    expect(xml).not.toContain("<foretagorgnr>");
    expect(xml).not.toContain("<foretagnamn>");
    expect(xml).toContain("<version>2.2</version>");
  });

  it("writes one tidtrans per post with anstid/persnr as attributes", () => {
    const xml = buildPaxmlXml(paxmlInput());
    // persnr is exactly 12 characters (yyyymmddnnnn) in the XSD — the stored
    // hyphen form must be normalised away.
    expect(xml).toContain('<tidtrans anstid="101" persnr="198001011234">');
    expect(xml).toContain("<tidkod>TID</tidkod>");
    expect(xml).toContain("<tidkod>ÖT1</tidkod>");
    expect(xml).toContain("<datum>2026-06-02</datum>");
    expect(xml).toContain("<timmar>8.00</timmar>");
    expect(xml).toContain("<timmar>1.50</timmar>");
    expect(xml.match(/<tidtrans /g)).toHaveLength(2);
  });

  it("keeps tidkod/datum/timmar in schema order inside tidtrans", () => {
    const xml = buildPaxmlXml(paxmlInput());
    const first = xml.slice(xml.indexOf("<tidtrans "), xml.indexOf("</tidtrans>"));
    expect(first.indexOf("<tidkod>")).toBeLessThan(first.indexOf("<datum>"));
    expect(first.indexOf("<datum>")).toBeLessThan(first.indexOf("<timmar>"));
  });

  it("omits persnr when it cannot be normalised to 12 digits", () => {
    const xml = buildPaxmlXml(
      paxmlInput({
        employees: [
          { employeeNumber: "102", personalIdentityNumber: null, days: [{ date: "2026-06-02", posts: [{ code: "TID", hours: 8 }] }] },
          { employeeNumber: "103", personalIdentityNumber: "800101-1234", days: [{ date: "2026-06-02", posts: [{ code: "TID", hours: 8 }] }] },
        ],
      })
    );
    expect(xml).toContain('<tidtrans anstid="102">');
    // Ten-digit personnummer has no unambiguous century — anstid still
    // identifies the employee, so the attribute is dropped rather than guessed.
    expect(xml).toContain('<tidtrans anstid="103">');
    expect(xml).not.toContain("persnr=");
  });

  it("escapes the employee number attribute", () => {
    const xml = buildPaxmlXml(
      paxmlInput({
        employees: [
          { employeeNumber: 'A&B"1"', personalIdentityNumber: null, days: [{ date: "2026-06-02", posts: [{ code: "TID", hours: 1 }] }] },
        ],
      })
    );
    expect(xml).toContain('<tidtrans anstid="A&amp;B&quot;1&quot;">');
  });

  it("strips an illegal control character from a free-text tidkod", () => {
    // A manually-entered PAXml code (frånvaro-/OB-register) could contain a
    // stray control character — it must never reach the exported XML.
    const xml = buildPaxmlXml(
      paxmlInput({
        employees: [
          {
            employeeNumber: "104",
            personalIdentityNumber: null,
            days: [{ date: "2026-06-02", posts: [{ code: "S\x01JK", hours: 1 }] }],
          },
        ],
      })
    );
    expect(xml).toContain("<tidkod>SJK</tidkod>");
    expect(xml).not.toMatch(/[\x00-\x08\x0B\x0C\x0E-\x1F]/);
  });

  it("always emits the tidtransaktioner container, even when there are no posts", () => {
    const xml = buildPaxmlXml(paxmlInput({ employees: [] }));
    expect(xml).toContain("<tidtransaktioner>");
    expect(xml).toContain("</tidtransaktioner>");
    expect(xml).not.toContain("<tidtrans ");
  });
});

// --- CSV ------------------------------------------------------------------

// A single day matching the employee-level aggregates below, so a snapshot
// built from this fixture emits real PAXml overtime posts (a day-less
// employee has nothing for getPaxmlExport to iterate).
function dayFixture(overrides: Partial<PayrollDay> = {}): PayrollDay {
  return {
    date: "2026-06-02",
    scheduledMinutes: 480,
    workedMinutes: 510,
    absences: [],
    ob: [],
    overtimeMinutes: 30,
    overtimeOffScheduleMinutes: 0,
    atfMinutes: 60,
    unaccountedMinutes: 0,
    overtimeDisposition: "payout",
    overtimeDispositionSource: "default",
    ...overrides,
  };
}

function employeeSummary(overrides: Partial<PeriodEmployeeSummary> = {}): PeriodEmployeeSummary {
  return {
    employeeId: crypto.randomUUID(),
    employeeNumber: "101",
    name: "Anna Andersson",
    employmentType: "hourly",
    scheduledMinutes: 480,
    workedMinutes: 510,
    absence: [],
    ob: [],
    overtimeMinutes: 30,
    overtimeOffScheduleMinutes: 0,
    overtimeCompMinutes: 0,
    overtimeOffScheduleCompMinutes: 0,
    atfMinutes: 60,
    unaccountedMinutes: 0,
    openAttendance: false,
    attested: true,
    attestedAt: null,
    attestedByName: null,
    days: [dayFixture()],
    ...overrides,
  };
}

function periodSummary(employees: PeriodEmployeeSummary[]): PeriodSummary {
  return { year: 2026, month: 6, status: "locked", lockedAt: null, generatedAt: "2026-07-01T00:00:00.000Z", employees };
}

describe("buildPayrollCsv", () => {
  it("starts with a UTF-8 BOM and the Swedish header row", () => {
    const csv = buildPayrollCsv(periodSummary([employeeSummary()]));
    expect(csv.startsWith("﻿")).toBe(true);
    const header = csv.slice(1).split("\r\n")[0];
    expect(header).toBe(
      "Anställningsnr;Namn;Anställningsform;Schema (h);Arbetad tid (h);Övertid utbet. (h);Övertid komp (h);Övertid helg utbet. (h);Övertid helg komp (h);ATF (h);Ofördelat (h)"
    );
  });

  it("writes hours with a decimal comma", () => {
    const csv = buildPayrollCsv(periodSummary([employeeSummary()]));
    const row = csv.split("\r\n")[1];
    expect(row).toBe("101;Anna Andersson;Timlön;8,00;8,50;0,50;0,00;0,00;0,00;1,00;0,00");
  });

  it("splits the overtime columns by disposition", () => {
    const csv = buildPayrollCsv(
      periodSummary([
        employeeSummary({
          overtimeMinutes: 90,
          overtimeCompMinutes: 30,
          overtimeOffScheduleMinutes: 60,
          overtimeOffScheduleCompMinutes: 60,
        }),
      ])
    );
    const rows = csv.slice(1).split("\r\n");
    expect(rows[0]).toContain("Övertid utbet. (h);Övertid komp (h);Övertid helg utbet. (h);Övertid helg komp (h)");
    const cells = rows[1]!.split(";");
    expect(cells[5]).toBe("1,00"); // 90 − 30
    expect(cells[6]).toBe("0,50");
    expect(cells[7]).toBe("0,00"); // 60 − 60
    expect(cells[8]).toBe("1,00");
  });

  it("treats a pre-feature snapshot row (missing comp fields) as all payout", () => {
    const employee = employeeSummary({ overtimeMinutes: 60 });
    delete (employee as Record<string, unknown>).overtimeCompMinutes;
    delete (employee as Record<string, unknown>).overtimeOffScheduleCompMinutes;
    const cells = buildPayrollCsv(periodSummary([employee])).split("\r\n")[1]!.split(";");
    expect(cells[5]).toBe("1,00");
    expect(cells[6]).toBe("0,00");
  });

  it("maps the employment form to Swedish labels and blanks an unset one", () => {
    const csv = buildPayrollCsv(
      periodSummary([
        employeeSummary({ employeeNumber: "1", employmentType: "monthly" }),
        employeeSummary({ employeeNumber: "2", employmentType: null }),
      ])
    );
    const rows = csv.split("\r\n");
    expect(rows[1]!.split(";")[2]).toBe("Månadslön");
    expect(rows[2]!.split(";")[2]).toBe("");
  });

  it("adds one column per absence and OB code present in the period, sorted by code", () => {
    const csv = buildPayrollCsv(
      periodSummary([
        employeeSummary({
          employeeNumber: "1",
          absence: [{ code: "SEM", name: "Semester", paxmlCode: "SEM", minutes: 480 }],
          ob: [{ code: "OB2", paxmlCode: "OB2", minutes: 60 }],
        }),
        employeeSummary({
          employeeNumber: "2",
          absence: [{ code: "SJK", name: "Sjukfrånvaro", paxmlCode: "SJK", minutes: 120 }],
          ob: [{ code: "OB1", paxmlCode: "OB1", minutes: 90 }],
        }),
      ])
    );
    const rows = csv.slice(1).split("\r\n");
    expect(rows[0]).toContain("Frånvaro SEM (h);Frånvaro SJK (h);OB OB1 (h);OB OB2 (h)");
    // Employee 1: SEM 8h, no SJK, no OB1, OB2 1h.
    expect(rows[1]!.endsWith("8,00;0,00;0,00;1,00")).toBe(true);
    // Employee 2: no SEM, SJK 2h, OB1 1.5h, no OB2.
    expect(rows[2]!.endsWith("0,00;2,00;1,50;0,00")).toBe(true);
  });

  it("prefixes OB columns so an OB code matching a fixed column word cannot collide", () => {
    // An OB rule literally coded "ATF" would otherwise produce a duplicate
    // "ATF (h)" header alongside the fixed ATF column.
    const csv = buildPayrollCsv(
      periodSummary([
        employeeSummary({
          employeeNumber: "1",
          ob: [{ code: "ATF", paxmlCode: "ATF", minutes: 60 }],
        }),
      ])
    );
    const cells = csv.slice(1).split("\r\n")[0]!.split(";");
    // Exactly one fixed "ATF (h)" column and a separate, distinctly-named
    // "OB ATF (h)" column for the OB rule — never two identical headers.
    expect(cells.filter((c) => c === "ATF (h)")).toHaveLength(1);
    expect(cells.filter((c) => c === "OB ATF (h)")).toHaveLength(1);
  });

  it("quotes values containing the separator", () => {
    const csv = buildPayrollCsv(periodSummary([employeeSummary({ name: 'Ove; "Ovesson"' })]));
    expect(csv).toContain('"Ove; ""Ovesson"""');
  });

  it("emits only the header row for an empty period", () => {
    const csv = buildPayrollCsv(periodSummary([]));
    expect(csv.slice(1).split("\r\n").filter((line) => line !== "")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Integration — the export methods on the payroll service.
// ---------------------------------------------------------------------------

const payrollRepository = createPayrollRepository(db);
const periodLocks = createPeriodLockChecker(payrollRepository);
const timeReportRepository = createTimeReportRepository(db);
const scheduleRepository = createScheduleRepository(db);
const atfRepository = createAtfRepository(db);
const auditRepository = createAuditRepository(db);
const authRepo = createAuthRepository(db);

const mfgService = createManufacturingService(
  createManufacturingRepository(db),
  testDocumentPdfService,
  testArticleService
);
const scheduleService = createScheduleService(scheduleRepository, timeReportRepository, periodLocks);

// Both settings and the company reader are stubbed: the PAXml codes and the
// company header are config, orthogonal to the export logic under test, and a
// fixed company keeps the header assertions deterministic.
const service = createPayrollService(
  payrollRepository,
  timeReportRepository,
  periodLocks,
  scheduleService,
  timeReportRepository,
  atfRepository,
  {
    getSettings: async () => ({
      payrollOvertimeThresholdMinutes: 0,
      paxmlCodeWorked: "TID",
      paxmlCodeOvertime: "ÖT1",
      paxmlCodeOvertimeOffSchedule: "ÖT2",
      paxmlCodeOvertimeComp: "ÖK1",
      paxmlCodeOvertimeOffScheduleComp: "ÖK2",
      paxmlCodeAtf: "ATF",
    }),
  },
  auditRepository,
  { getCompanyInfo: async () => COMPANY },
  // The PDF report has its own coverage in payroll-pdf.test.ts (with the
  // real renderer) — a stub keeps this file focused on PAXml/CSV export.
  { renderPayrollReport: async () => Buffer.from("") }
);

const TRUNCATE = sql`TRUNCATE
  absences, absence_types, ob_rules, payroll_periods, payroll_attestations,
  attendance_sessions, stamp_sessions, time_reports, atf_transactions,
  employee_day_overrides, employee_week_overrides,
  week_schedule_days, week_schedules, day_schedule_breaks, day_schedules,
  holidays, employees,
  mo_material_consumptions, mo_operations, manufacturing_orders, routing_operations, work_centers,
  bom_components, articles,
  audit_log, users
  CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

// Fixed, already-ended period (same as payroll-attest.test.ts).
const YEAR = 2026;
const MONTH = 5;

function localDate(year: number, month: number, day: number, hour = 0, minute = 0): Date {
  return new Date(year, month - 1, day, hour, minute, 0);
}

async function backdateAttendanceSession(id: string, startedAt: Date, stoppedAt: Date | null) {
  await db.execute(sql`
    UPDATE attendance_sessions
    SET started_at = ${startedAt.toISOString()}::timestamptz,
        stopped_at = ${stoppedAt === null ? null : stoppedAt.toISOString()}::timestamptz
    WHERE id = ${id}
  `);
}

async function makeUser() {
  return authRepo.create({
    email: `payroll-export-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Löneadmin",
    role: "admin",
  });
}

// One hourly and one monthly employee, both with a worked day, an absence and
// an ATF withdrawal in May 2026 — the pair that proves worked time is exported
// for hourly employees only.
async function seedPeriod() {
  const user = await makeUser();

  const daySchedule = await scheduleService.createDaySchedule({
    code: "DAG",
    name: "Dagtid",
    startTime: "07:00",
    endTime: "16:00",
    active: true,
    breaks: [{ type: "unpaid", startTime: "12:00", endTime: "13:00" }],
  });
  const weekSchedule = await scheduleService.createWeekSchedule({
    code: "VDAG",
    name: "Dagtid vecka",
    active: true,
    days: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, dayScheduleId: daySchedule.id })),
  });

  // The register code and the PAXml code deliberately differ, so a mix-up
  // between the two would fail: the XML must carry paxmlCode, the CSV code.
  const absenceType = await service.createAbsenceType({ code: "SJUK", name: "Sjukfrånvaro", paxmlCode: "SJK" });
  // Morning OB, weekdays only — covered by the 06:00 start on 2026-05-07 and
  // NOT by the Saturday session (which is dayKind "saturday").
  await service.createObRule({
    code: "OB-MORGON",
    name: "Morgon-OB",
    dayKind: "weekday",
    startTime: "06:00",
    endTime: "07:00",
    paxmlCode: "OB1",
  });

  async function makeEmployee(name: string, employmentType: "hourly" | "monthly", personalIdentityNumber: string | null) {
    const employee = await timeReportRepository.createEmployee({
      employeeNumber: `E-${crypto.randomUUID().slice(0, 8)}`,
      name,
      active: true,
      employmentType,
      personalIdentityNumber,
    });
    await timeReportRepository.updateEmployee(employee.id, { defaultWeekScheduleId: weekSchedule.id });

    async function session(from: Date, to: Date) {
      const row = await timeReportRepository.createAttendanceSession(employee.id, user.id);
      await backdateAttendanceSession(row.id, from, to);
    }

    // Mon 2026-05-04: exactly the schedule (07–16 less the unpaid hour) — 480
    // worked, no overtime.
    await session(localDate(2026, 5, 4, 7, 0), localDate(2026, 5, 4, 16, 0));
    // Thu 2026-05-07: an hour early — 540 worked, 60 over schedule, and the
    // 06:00–07:00 hour falls inside the OB window.
    await session(localDate(2026, 5, 7, 6, 0), localDate(2026, 5, 7, 16, 0));
    // Sat 2026-05-09: schedule-free, so every worked minute is weekend
    // overtime and none of it is worked-within-schedule time.
    await session(localDate(2026, 5, 9, 8, 0), localDate(2026, 5, 9, 16, 0));

    await service.createAbsence(employee.id, { absenceTypeId: absenceType.id, date: "2026-05-05", minutes: 120 }, user.id);
    await atfRepository.createAtfTransaction(employee.id, { date: "2026-05-06", type: "withdrawal", minutes: 60 }, user.id);

    return employee;
  }

  const hourly = await makeEmployee("Anna Andersson", "hourly", "19800101-1234");
  const monthly = await makeEmployee("Bertil Bengtsson", "monthly", "19750315-5678");

  return { user, hourly, monthly };
}

async function lockedMay() {
  const seeded = await seedPeriod();
  await service.attest(YEAR, MONTH, seeded.hourly.id, seeded.user.id);
  await service.attest(YEAR, MONTH, seeded.monthly.id, seeded.user.id);
  await service.lockPeriod(YEAR, MONTH, seeded.user.id);
  return seeded;
}

// All tidtrans blocks belonging to one employee number.
function transactionsFor(xml: string, employeeNumber: string): string[] {
  return [...xml.matchAll(/<tidtrans [^>]*>[\s\S]*?<\/tidtrans>/g)]
    .map((m) => m[0])
    .filter((block) => block.includes(`anstid="${employeeNumber}"`));
}

// One employee's posts as sortable "code date hours" strings, so a whole
// period can be asserted as an exact set regardless of emission order.
function postsFor(xml: string, employeeNumber: string): string[] {
  return transactionsFor(xml, employeeNumber)
    .map((block) => {
      const value = (tag: string) => new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(block)?.[1] ?? "";
      return `${value("tidkod")} ${value("datum")} ${value("timmar")}`;
    })
    .sort();
}

describe("getPaxmlExport", () => {
  it("refuses an unlocked period", async () => {
    const seeded = await seedPeriod();
    await expect(service.getPaxmlExport(YEAR, MONTH, seeded.user.id)).rejects.toBeInstanceOf(PeriodNotLockedError);
  });

  it("refuses a period that was never touched", async () => {
    const user = await makeUser();
    await expect(service.getPaxmlExport(YEAR, MONTH, user.id)).rejects.toBeInstanceOf(PeriodNotLockedError);
  });

  it("exports the locked snapshot as a PAXml 2.2 file", async () => {
    const seeded = await lockedMay();
    const { filename, content } = await service.getPaxmlExport(YEAR, MONTH, seeded.user.id);

    expect(filename).toBe("paxml-2026-05.xml");
    const xml = content.toString("utf8");
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain("<version>2.2</version>");
    expect(xml).toContain("<foretagorgnr>556000-0000</foretagorgnr>");
    expect(xml).toContain('persnr="198001011234"');
  });

  it("exports every post category exactly once for an hourly employee", async () => {
    const seeded = await lockedMay();
    const { content } = await service.getPaxmlExport(YEAR, MONTH, seeded.user.id);

    // Worked time is capped at schedule time: 2026-05-07 has 540 worked
    // minutes of which 60 are overtime, so TID is 8.00 (not 9.00) and ÖT1
    // carries the extra hour — the hours are never reported twice. The
    // schedule-free Saturday is 8 hours of ÖT2 and NO worked post at all.
    expect(postsFor(content.toString("utf8"), seeded.hourly.employeeNumber)).toEqual([
      "ATF 2026-05-06 1.00",
      "OB1 2026-05-07 1.00",
      "SJK 2026-05-05 2.00",
      "TID 2026-05-04 8.00",
      "TID 2026-05-07 8.00",
      "ÖT1 2026-05-07 1.00",
      "ÖT2 2026-05-09 8.00",
    ]);
  });

  it("exports the same deviations for a monthly employee, minus the worked time", async () => {
    const seeded = await lockedMay();
    const { content } = await service.getPaxmlExport(YEAR, MONTH, seeded.user.id);

    // Månadslön: the monthly salary already pays the scheduled hours, so no
    // TID — but every deviation (absence, OB, overtime, ATF) still goes to
    // payroll.
    expect(postsFor(content.toString("utf8"), seeded.monthly.employeeNumber)).toEqual([
      "ATF 2026-05-06 1.00",
      "OB1 2026-05-07 1.00",
      "SJK 2026-05-05 2.00",
      "ÖT1 2026-05-07 1.00",
      "ÖT2 2026-05-09 8.00",
    ]);
  });

  it("uses the register entries' PAXml codes, not their own codes", async () => {
    const seeded = await lockedMay();
    const { content } = await service.getPaxmlExport(YEAR, MONTH, seeded.user.id);
    const xml = content.toString("utf8");

    // The absence type is SJUK/SJK and the OB rule OB-MORGON/OB1.
    expect(xml).toContain("<tidkod>SJK</tidkod>");
    expect(xml).toContain("<tidkod>OB1</tidkod>");
    expect(xml).not.toContain("SJUK");
    expect(xml).not.toContain("OB-MORGON");
  });

  it("omits zero-hour posts", async () => {
    const seeded = await lockedMay();
    const { content } = await service.getPaxmlExport(YEAR, MONTH, seeded.user.id);
    expect(content.toString("utf8")).not.toContain("<timmar>0.00</timmar>");
  });

  it("logs the export in the audit trail", async () => {
    const seeded = await lockedMay();
    await service.getPaxmlExport(YEAR, MONTH, seeded.user.id);

    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, "payroll_period"), eq(auditLog.action, "paxml_exported")));

    expect(rows).toHaveLength(1);
    expect(rows[0]!.entityId).toBe("2026-05");
    expect(rows[0]!.userId).toBe(seeded.user.id);
    const detail = rows[0]!.detail as { employeeCount: number; postCount: number };
    expect(detail.employeeCount).toBe(2);
    expect(detail.postCount).toBeGreaterThan(0);
  });

  it("exports comp-day overtime with the ÖK codes and payout days with ÖT codes", async () => {
    // seedPeriod() already gives the hourly employee overtime on two days:
    // 2026-05-07 (60 min over schedule, on-schedule overtime) and 2026-05-09
    // (a schedule-free Saturday, all overtimeOffSchedule). Mark BOTH as comp
    // for the hourly employee before locking; the monthly employee is left
    // untouched on the default (payout), so the same export proves ÖT1/ÖT2
    // (payout) and ÖK1/ÖK2 (comp) all at once.
    const seeded = await seedPeriod();
    await service.setOvertimeDisposition(seeded.hourly.id, "2026-05-07", "comp", seeded.user.id);
    await service.setOvertimeDisposition(seeded.hourly.id, "2026-05-09", "comp", seeded.user.id);
    await service.attest(YEAR, MONTH, seeded.hourly.id, seeded.user.id);
    await service.attest(YEAR, MONTH, seeded.monthly.id, seeded.user.id);
    await service.lockPeriod(YEAR, MONTH, seeded.user.id);

    const { content } = await service.getPaxmlExport(YEAR, MONTH, seeded.user.id);
    const xml = content.toString("utf8");
    expect(xml).toContain(">ÖT1<");
    expect(xml).toContain(">ÖT2<");
    expect(xml).toContain(">ÖK1<");
    expect(xml).toContain(">ÖK2<");
  });

  it("locks the disposition into the snapshot — a later default change does not move the export", async () => {
    // lockedMay() locks with every day on the employee default (payout, no
    // overrides set) — so the snapshot's per-day disposition is "payout"
    // before the default is ever touched.
    const seeded = await lockedMay();

    await timeReportRepository.updateEmployee(seeded.hourly.id, { overtimeCompensation: "comp" });

    const { content } = await service.getPaxmlExport(YEAR, MONTH, seeded.user.id);
    const xml = content.toString("utf8");
    expect(xml).not.toContain("ÖK1");
  });

  it("serves a pre-feature snapshot as payout with zero comp aggregates", async () => {
    const user = await makeUser();

    // Build a snapshot with the pure fixture builders, then strip the fields
    // this feature adds — simulating a period locked before the feature
    // existed, whose stored JSON simply lacks them.
    const legacy = JSON.parse(JSON.stringify(periodSummary([employeeSummary()])));
    for (const emp of legacy.employees) {
      delete emp.overtimeCompMinutes;
      delete emp.overtimeOffScheduleCompMinutes;
      for (const d of emp.days) {
        delete d.overtimeDisposition;
        delete d.overtimeDispositionSource;
      }
    }

    const period = await payrollRepository.ensurePayrollPeriod(legacy.year, legacy.month);
    await payrollRepository.lockPayrollPeriod(period.id, { ...legacy, status: "locked" }, new Date(), user.id);

    const { content } = await service.getPaxmlExport(legacy.year, legacy.month, user.id);
    const xml = content.toString("utf8");
    expect(xml).toContain(">ÖT1<");
    expect(xml).not.toContain("ÖK1");
    expect(xml).not.toContain("ÖK2");

    await expect(service.getPeriodSummary(legacy.year, legacy.month)).resolves.toBeDefined();
    await expect(service.getCsvExport(legacy.year, legacy.month)).resolves.toBeDefined();
  });
});

describe("getCsvExport", () => {
  it("works on an open period (preview) and lists every employee", async () => {
    const seeded = await seedPeriod();
    const { filename, content } = await service.getCsvExport(YEAR, MONTH);

    expect(filename).toBe("loneunderlag-2026-05.csv");
    expect(content.startsWith("﻿")).toBe(true);
    expect(content).toContain("Anställningsnr;Namn;Anställningsform");
    // The CSV is the human-facing view, so it uses the register code (SJUK)
    // where the PAXml file uses the tidkod (SJK).
    expect(content).toContain("Frånvaro SJUK (h)");
    expect(content).toContain("OB OB-MORGON (h)");
    expect(content).toContain(seeded.hourly.employeeNumber);
    expect(content).toContain("Timlön");
    expect(content).toContain("Månadslön");
    // The absence is 120 minutes for both employees.
    expect(content).toContain("2,00");
  });

  it("serves the frozen snapshot once the period is locked", async () => {
    const seeded = await lockedMay();
    const { content } = await service.getCsvExport(YEAR, MONTH);
    expect(content).toContain(seeded.hourly.employeeNumber);
    expect(content).toContain(seeded.monthly.employeeNumber);
  });
});
