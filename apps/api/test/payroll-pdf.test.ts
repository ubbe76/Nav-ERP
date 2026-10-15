import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { inflateSync } from "node:zlib";
import { sql } from "drizzle-orm";
import { db } from "@navet/db";
import { PAXML_CODES, testDocumentPdfService } from "./helpers/services.js";
import { decodeWinAnsiHex, pdfText } from "./helpers/pdf.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createPayrollRepository } from "../src/modules/payroll/repository/payroll.repository.js";
import { createPayrollService } from "../src/modules/payroll/service/payroll.service.js";
import { createAtfRepository } from "../src/modules/timereport/repository/atf.repository.js";
import { createScheduleRepository } from "../src/modules/timereport/repository/schedule.repository.js";
import { createScheduleService } from "../src/modules/timereport/service/schedule.service.js";
import { createTimeReportRepository } from "../src/modules/timereport/repository/timereport.repository.js";

// Real repositories/services throughout, plus the real PDF renderer
// (testDocumentPdfService) — this file is specifically about the rendered
// PDF's content, so unlike the other payroll test files it does not stub
// renderPayrollReport.
const payrollRepository = createPayrollRepository(db);
const timeReportRepository = createTimeReportRepository(db);
const scheduleService = createScheduleService(createScheduleRepository(db), timeReportRepository, {
  isDateLocked: async () => false,
});
const atfRepository = createAtfRepository(db);
const authRepo = createAuthRepository(db);

const service = createPayrollService(
  payrollRepository,
  timeReportRepository,
  { isDateLocked: async () => false },
  scheduleService,
  timeReportRepository,
  atfRepository,
  { getSettings: async () => ({ payrollOvertimeThresholdMinutes: 0, ...PAXML_CODES }) },
  { log: async () => {} },
  // Only the exports read the company header — see payroll-export.test.ts.
  { getCompanyInfo: async () => null },
  testDocumentPdfService
);

const TRUNCATE = sql`TRUNCATE
  absences, absence_types, ob_rules, payroll_periods, payroll_attestations,
  attendance_sessions, stamp_sessions, time_reports, atf_transactions,
  employee_day_overrides, employee_week_overrides,
  week_schedule_days, week_schedules, day_schedule_breaks, day_schedules,
  holidays, employees, users
  CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

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
    email: `payroll-pdf-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Löneadmin",
    role: "admin",
  });
}

// Fixed, already-ended period (same as payroll-attest.test.ts/payroll-export.test.ts).
const YEAR = 2026;
const MONTH = 5;

// Minimal fixture — the light parts of payroll-export.test.ts's seedPeriod:
// one hourly employee with a Monday session that exactly matches the
// schedule, a SJK absence booking, and two extra weekday sessions that each
// run an hour past schedule — one left on the employee default (payout), one
// overridden to comp — so the report prints both the payout and comp
// on-schedule overtime rows. No weekend/off-schedule work is booked, so
// "Övertid helg – …" stays a deliberate zero row (omitted entirely).
async function seedMinimalPeriod() {
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

  const absenceType = await service.createAbsenceType({ code: "SJUK", name: "Sjukfrånvaro", paxmlCode: "SJK" });

  const employee = await timeReportRepository.createEmployee({
    employeeNumber: `E-${crypto.randomUUID().slice(0, 8)}`,
    name: "Anna Andersson",
    active: true,
    employmentType: "hourly",
  });
  await timeReportRepository.updateEmployee(employee.id, { defaultWeekScheduleId: weekSchedule.id });

  // Mon 2026-05-04: exactly the schedule (07–16 less the unpaid hour) — 480
  // worked, no overtime.
  const session = await timeReportRepository.createAttendanceSession(employee.id, user.id);
  await backdateAttendanceSession(session.id, localDate(2026, 5, 4, 7, 0), localDate(2026, 5, 4, 16, 0));

  await service.createAbsence(
    employee.id,
    { absenceTypeId: absenceType.id, date: "2026-05-05", minutes: 120 },
    user.id
  );

  // Wed 2026-05-06 and Thu 2026-05-07: each an hour past the schedule (07–17
  // instead of 07–16), so both days generate 60 min of on-schedule overtime.
  // The Wednesday one stays on the employee default (payout); the Thursday
  // one is overridden to comp — together they give the report a nonzero
  // payout row AND a nonzero comp row for the same "Övertid" pair.
  const wedSession = await timeReportRepository.createAttendanceSession(employee.id, user.id);
  await backdateAttendanceSession(wedSession.id, localDate(2026, 5, 6, 7, 0), localDate(2026, 5, 6, 17, 0));
  const thuSession = await timeReportRepository.createAttendanceSession(employee.id, user.id);
  await backdateAttendanceSession(thuSession.id, localDate(2026, 5, 7, 7, 0), localDate(2026, 5, 7, 17, 0));
  await service.setOvertimeDisposition(employee.id, "2026-05-07", "comp", user.id);

  return { user, employee };
}

describe("payroll service — PDF report", () => {
  it("renders the period basis as a printable PDF, skipping zero rows", async () => {
    const { employee } = await seedMinimalPeriod();

    const { filename, content } = await service.getPayrollPdf(YEAR, MONTH);
    expect(filename).toBe("loneunderlag-2026-05.pdf");
    expect(content.subarray(0, 4).toString()).toBe("%PDF");

    const text = pdfText(content);
    expect(text).toContain("Löneunderlag maj 2026");
    // The period is open (never locked/attested) — the status line must say so.
    expect(text).toContain("Ej låst (preliminärt)");
    expect(text).toContain(employee.name);
    expect(text).toContain("Arbetad tid");
    expect(text).toContain("Sjukfrånvaro");
    // The fixture's Wed/Thu overtime splits into a payout row and a comp row.
    expect(text).toContain("Övertid – utbetalning");
    expect(text).toContain("Övertid – komptid");
    // No weekend/off-schedule work in the fixture — the comp row for it
    // stays a deliberate zero row (omitted entirely).
    expect(text).not.toContain("Övertid helg – komptid");
  });
});

// ---------------------------------------------------------------------------
// Pagination — regression coverage for the "orphaned employee header" bug:
// renderPayrollReport's per-employee page-break guard used to reserve only
// the header's own 18pt, so a section starting at y in (749, 764] printed
// its bold "name (number) — type" header at the bottom of one page and its
// first row at the top of the next. The fix widens the guard to reserve the
// header PLUS the first row together (document-pdf.ts).
//
// The shared `pdfText` test helper concatenates every page's content stream
// into one string and therefore CANNOT prove page adjacency: text order is
// identical whether a header and its row land on the same page or either
// side of a break, so a plain toContain/not.toContain assertion against
// pdfText's output would pass identically whether or not the bug is
// present. `pdfPagesText` below instead keeps each content stream (== each
// page, for this renderer) separate, so the test can check that a header
// found on a given page has its own first row on that SAME page.
// ---------------------------------------------------------------------------

// Per-page variant of the pdfText helper (test/helpers/pdf.ts) — same
// inflate + hex-decode logic, but keeps each "stream…endstream" block's
// decoded text separate instead of concatenating them. pdfkit writes one
// content stream per page (nothing here uses drawFooter/switchToPage, which
// is the one thing that revisits an already-written page), so each
// non-empty entry corresponds to one page in document order. Local to this
// test file — not promoted to test/helpers/pdf.ts since no other test needs
// page-level granularity.
function pdfPagesText(buffer: Buffer): string[] {
  const marker = Buffer.from("stream\n");
  const end = Buffer.from("endstream");
  const pages: string[] = [];
  let offset = 0;
  while (true) {
    const start = buffer.indexOf(marker, offset);
    if (start === -1) break;
    const from = start + marker.length;
    const to = buffer.indexOf(end, from);
    if (to === -1) break;
    try {
      const decoded = inflateSync(buffer.subarray(from, to)).toString("latin1");
      let text = "";
      for (const [, hex] of decoded.matchAll(/<([0-9a-fA-F]+)>/g)) {
        text += decodeWinAnsiHex(hex!);
      }
      if (text.length > 0) pages.push(text);
    } catch {
      // Not a deflate content stream (fonts, xref, etc.) — skip, same as pdfText.
    }
    offset = to + end.length;
  }
  return pages;
}

describe("payroll service — PDF report pagination", () => {
  it("keeps every employee's header on the same page as its first row, across a multi-page report", async () => {
    // Renders through the document-PDF service directly (bypassing the
    // payroll service and the DB entirely — this is about the renderer's
    // layout, not the payroll basis), so row counts and heights are exactly
    // under our control. 60 employees with row counts cycling 1–5 produce
    // many different header start-Y offsets across the document, making it
    // overwhelmingly likely at least one header lands in the risky window.
    // Empirically confirmed (see the fix report): reverting the
    // document-pdf.ts guard back to `y + 16 > TABLE_BOTTOM` makes this exact
    // test fail; restoring the widened guard makes it pass again — so this
    // fixture does exercise the bug, not just pad the file with an
    // unrelated large-PDF test.
    const employees = Array.from({ length: 60 }, (_, i) => {
      const rowCount = (i % 5) + 1;
      return {
        employeeNumber: `E-${String(i + 1).padStart(3, "0")}`,
        name: `Anställd ${String(i + 1).padStart(3, "0")}`,
        employmentTypeLabel: "Timlön",
        rows: Array.from({ length: rowCount }, (_, r) => ({
          label: `Rad ${i + 1}-${r + 1}`,
          hours: "1,00",
        })),
      };
    });

    const buffer = await testDocumentPdfService.renderPayrollReport({
      periodLabel: "Löneunderlag maj 2026",
      status: "Ej låst (preliminärt)",
      employees,
    });

    // The fixture must actually be dense enough to force more than one
    // page, or the page-break guard under test is never exercised at all.
    const rawPageCount = (buffer.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    expect(rawPageCount).toBeGreaterThan(1);

    const pages = pdfPagesText(buffer);
    expect(pages.length).toBeGreaterThan(1);

    // The actual regression assertion: every employee header found on a
    // page must have that SAME employee's first row on the SAME page —
    // never split across the page boundary.
    let checkedHeaders = 0;
    for (const pageText of pages) {
      for (const employee of employees) {
        const headerText = `${employee.name} (${employee.employeeNumber})`;
        if (!pageText.includes(headerText)) continue;
        checkedHeaders++;
        expect(pageText).toContain(employee.rows[0]!.label);
      }
    }
    // Proves the loop above actually matched every employee's header
    // exactly once (i.e. was not silently vacuous, e.g. due to a hex-decode
    // mismatch) — each employee has exactly one header, printed once.
    expect(checkedHeaders).toBe(employees.length);
  });
});
