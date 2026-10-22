import type {
  CreateAbsenceInput,
  CreateAbsenceTypeInput,
  CreateAttendanceDeviationReasonInput,
  UpdateAttendanceDeviationReasonInput,
  CreateObRuleInput,
  OvertimeDisposition,
  UpdateAbsenceTypeInput,
  UpdateObRuleInput,
} from "@navet/shared";
import type { PayrollRepository } from "../repository/payroll.repository.js";
// Append-only audit trail; the payroll module is its first writer (block G1).
import type { AuditWriter } from "../../system/repository/audit.repository.js";
import { isUniqueViolation } from "../../system/service/db-errors.js";
// The employee register lives in the timereport module; payroll only needs
// existence checks, and reuses its 404 shape (same trick as ATF/schedule's
// EmployeeReader — see schedule.service.ts:165 — but across module
// boundaries, same as RegisterEntryNotFoundError being reused by purchase/sales).
import { EmployeeNotFoundError } from "../../timereport/service/timereport.service.js";
// listEmployees() already returns the full employee register row — reused
// as-is rather than building a second employee lister for payroll.
import type { TimeReportRepository } from "../../timereport/repository/timereport.repository.js";
import type { ResolvedDay } from "../../timereport/service/schedule.service.js";
import {
  computeEmployeeDay,
  dayBounds,
  periodDates,
  periodRange,
  type DayComputation,
  type Interval,
  type ObRuleInput,
} from "./payroll-day.js";
import { buildPaxmlXml, type PaxmlEmployeeInput, type PaxmlPost } from "./paxml.js";
import { buildPayrollCsv } from "./payroll-csv.js";
import { PayrollPeriodLockedError, type PeriodLockChecker } from "./period-lock.js";
// The printable löneunderlag PDF — same pattern as the plocklista/TO
// printout, narrowed to just the one renderer this module needs.
import type { DocumentPdfService } from "../../mail/service/document-pdf.js";

export type EmployeeRow = Awaited<ReturnType<TimeReportRepository["listEmployees"]>>[number];
type AbsenceRow = Awaited<ReturnType<PayrollRepository["listEmployeeAbsences"]>>[number];

// A period day: the pure engine output decorated with how that day's
// overtime is compensated. The disposition is an INPUT (override ?? employee
// default), not derived from stamps — which is why payroll-day.ts stays pure.
export type PayrollDay = DayComputation & {
  overtimeDisposition: OvertimeDisposition;
  overtimeDispositionSource: "default" | "override";
};

// Pre-feature snapshots (locked before overtime dispositions existed) lack
// the decoration fields — read them as payout/default so old exports stay
// byte-identical.
function normalizePayrollDay(day: DayComputation & Partial<PayrollDay>): PayrollDay {
  return {
    ...day,
    overtimeDisposition: day.overtimeDisposition ?? "payout",
    overtimeDispositionSource: day.overtimeDispositionSource ?? "default",
  };
}

// Structural shapes for the collaborators getPeriodSummary/getEmployeePeriodDays
// depend on — satisfied by scheduleService/timeReportRepository/atf
// repository/systemService in app.ts, and by lightweight stubs in tests.
export interface AttendanceRow {
  id: string;
  employeeId: string;
  startedAt: Date;
  stoppedAt: Date | null;
}

export interface AtfRow {
  employeeId: string;
  date: string;
  minutes: number;
}

export interface PeriodEmployeeSummary {
  employeeId: string;
  employeeNumber: string;
  name: string;
  employmentType: "hourly" | "monthly" | null;
  scheduledMinutes: number;
  workedMinutes: number;
  absence: { code: string; name: string; paxmlCode: string; minutes: number }[];
  ob: { code: string; paxmlCode: string; minutes: number }[];
  overtimeMinutes: number;
  overtimeOffScheduleMinutes: number;
  // Comp-time share of the overtime totals above (payout share = total − comp).
  overtimeCompMinutes: number;
  overtimeOffScheduleCompMinutes: number;
  atfMinutes: number;
  unaccountedMinutes: number;
  openAttendance: boolean; // unstopped session started before period end
  attested: boolean;
  attestedAt: string | null;
  attestedByName: string | null;
  days: PayrollDay[]; // per-day detail (also the PAXml source)
}

export interface PeriodSummary {
  year: number;
  month: number;
  status: "open" | "locked";
  lockedAt: string | null;
  generatedAt: string;
  employees: PeriodEmployeeSummary[];
}

// --- Pure helpers for grouping raw rows into the day-engine's per-day shape ---
// (module-scope, no DB access — kept separate from the service factory so
// they're trivially unit-testable and never touch the closures below.)

function localDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// All local calendar dates a raw [start, end) attendance interval touches,
// inclusive of both endpoints' dates. computeEmployeeDay clips the interval
// to each day's bounds itself, so over-including a boundary date here just
// yields an empty (filtered-out) contribution on that day — never a wrong one.
function spanningDates(start: Date, end: Date): string[] {
  const dates: string[] = [];
  const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const last = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  while (cursor <= last) {
    dates.push(localDateString(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
}

function groupByEmployeeId<T extends { employeeId: string }>(rows: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const list = map.get(row.employeeId) ?? [];
    list.push(row);
    map.set(row.employeeId, list);
  }
  return map;
}

// Open sessions (stoppedAt === null) are dropped here — they contribute 0
// worked minutes by design; the openAttendance flag is derived separately
// from the raw session list, not from this grouping.
function groupIntervalsByDate(sessions: AttendanceRow[]): Map<string, Interval[]> {
  const byDate = new Map<string, Interval[]>();
  for (const session of sessions) {
    if (session.stoppedAt === null) continue;
    const interval: Interval = { start: session.startedAt.getTime(), end: session.stoppedAt.getTime() };
    for (const date of spanningDates(session.startedAt, session.stoppedAt)) {
      const list = byDate.get(date) ?? [];
      list.push(interval);
      byDate.set(date, list);
    }
  }
  return byDate;
}

function sumBy<T>(items: T[], selector: (item: T) => number): number {
  return items.reduce((total, item) => total + selector(item), 0);
}

function aggregateObMinutes(days: DayComputation[]): { code: string; paxmlCode: string; minutes: number }[] {
  const totals = new Map<string, { code: string; paxmlCode: string; minutes: number }>();
  for (const day of days) {
    for (const entry of day.ob) {
      const existing = totals.get(entry.code);
      if (existing) existing.minutes += entry.minutes;
      else totals.set(entry.code, { ...entry });
    }
  }
  return [...totals.values()];
}

function aggregateAbsenceMinutes(rows: AbsenceRow[]): { code: string; name: string; paxmlCode: string; minutes: number }[] {
  const totals = new Map<string, { code: string; name: string; paxmlCode: string; minutes: number }>();
  for (const row of rows) {
    const existing = totals.get(row.absenceTypeCode);
    if (existing) existing.minutes += row.minutes;
    else {
      totals.set(row.absenceTypeCode, {
        code: row.absenceTypeCode,
        name: row.absenceTypeName,
        paxmlCode: row.absenceTypePaxmlCode,
        minutes: row.minutes,
      });
    }
  }
  return [...totals.values()];
}

interface EmployeeDayInputs {
  dates: string[];
  holidaySet: Set<string>;
  obRuleInputs: ObRuleInput[];
  overtimeThresholdMinutes: number;
  calendar: ResolvedDay[];
  sessions: AttendanceRow[];
  atfRows: AtfRow[];
  absenceRows: AbsenceRow[];
  defaultDisposition: OvertimeDisposition;
  dispositionByDate: Map<string, OvertimeDisposition>;
}

// Shared by getPeriodSummary (looped per employee) and getEmployeePeriodDays
// (single employee) so the grouping/engine-call logic lives in exactly one
// place.
function computeDaysForEmployee(inputs: EmployeeDayInputs): PayrollDay[] {
  const calendarByDate = new Map(inputs.calendar.map((d) => [d.date, d]));
  const attendanceByDate = groupIntervalsByDate(inputs.sessions);

  const atfByDate = new Map<string, number>();
  for (const row of inputs.atfRows) {
    atfByDate.set(row.date, (atfByDate.get(row.date) ?? 0) + row.minutes);
  }

  const absencesByDate = new Map<string, { code: string; paxmlCode: string; minutes: number }[]>();
  for (const row of inputs.absenceRows) {
    const list = absencesByDate.get(row.date) ?? [];
    list.push({ code: row.absenceTypeCode, paxmlCode: row.absenceTypePaxmlCode, minutes: row.minutes });
    absencesByDate.set(row.date, list);
  }

  return inputs.dates.map((date) => {
    const calendarDay = calendarByDate.get(date);
    const computed = computeEmployeeDay({
      date,
      isHoliday: inputs.holidaySet.has(date),
      schedule: calendarDay?.daySchedule
        ? { netMinutes: calendarDay.daySchedule.netMinutes, breaks: calendarDay.daySchedule.breaks }
        : null,
      attendance: attendanceByDate.get(date) ?? [],
      absences: absencesByDate.get(date) ?? [],
      atfMinutes: atfByDate.get(date) ?? 0,
      obRules: inputs.obRuleInputs,
      overtimeThresholdMinutes: inputs.overtimeThresholdMinutes,
    });

    const override = inputs.dispositionByDate.get(date);
    return {
      ...computed,
      overtimeDisposition: override ?? inputs.defaultDisposition,
      overtimeDispositionSource: override !== undefined ? ("override" as const) : ("default" as const),
    };
  });
}

// Shared attendance-range window for one calendar month: local midnight of
// day 1 through local midnight of the day after the last day.
function attendanceWindow(dates: string[]): { from: Date; to: Date } {
  return {
    from: new Date(dayBounds(dates[0]!).start),
    to: new Date(dayBounds(dates[dates.length - 1]!).end),
  };
}

// Today in the server's local timezone as YYYY-MM-DD (sv-SE formats
// ISO-style) — same idiom as timereport/atf.
const localToday = () => new Date().toLocaleDateString("sv-SE");

// Audit-log entity id for a period: "2026-05" (the period has no natural
// external key, and its row id means nothing to a reader of the log).
const periodKey = (year: number, month: number) => `${year}-${String(month).padStart(2, "0")}`;

// Swedish month names (lowercase), 1-indexed by month number — used for the
// PDF report's periodLabel ("Löneunderlag juni 2026").
const MONTH_NAMES_SV = [
  "januari",
  "februari",
  "mars",
  "april",
  "maj",
  "juni",
  "juli",
  "augusti",
  "september",
  "oktober",
  "november",
  "december",
] as const;

const EMPLOYMENT_TYPE_LABELS: Record<"hourly" | "monthly", string> = {
  hourly: "Timlön",
  monthly: "Månadslön",
};

export class AbsenceTypeNotFoundError extends Error {
  constructor(id: string) {
    super(`Absence type ${id} not found`);
    this.name = "AbsenceTypeNotFoundError";
  }
}

export class AttendanceDeviationReasonNotFoundError extends Error {
  constructor(id: string) {
    super(`Attendance deviation reason ${id} not found`);
    this.name = "AttendanceDeviationReasonNotFoundError";
  }
}

export class ObRuleNotFoundError extends Error {
  constructor(id: string) {
    super(`OB rule ${id} not found`);
    this.name = "ObRuleNotFoundError";
  }
}

export class DuplicatePayrollCodeError extends Error {
  constructor(field: "code" | "name", value: string) {
    super(field === "code" ? `An entry with code ${value} already exists` : `An entry named ${value} already exists`);
    this.name = "DuplicatePayrollCodeError";
  }
}

// Semantic validation failure — OB window's end time not after its start
// time. Windows may not cross midnight (same v1 rule as day_schedules);
// night OB is entered as two rows (22–24 and 00–06).
export class InvalidObWindowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidObWindowError";
  }
}

export class AbsenceNotFoundError extends Error {
  constructor(id: string) {
    super(`Absence ${id} not found`);
    this.name = "AbsenceNotFoundError";
  }
}

export class DuplicateAbsenceError extends Error {
  constructor() {
    super("An absence of this type already exists for the employee on this date");
    this.name = "DuplicateAbsenceError";
  }
}

// Semantic validation failure — the referenced absence type exists but is
// inactive (deactivated codes may still appear on historical bookings, but
// cannot be used for new ones).
export class InactiveAbsenceTypeError extends Error {
  constructor(id: string) {
    super(`Absence type ${id} is inactive`);
    this.name = "InactiveAbsenceTypeError";
  }
}

export class OvertimeDispositionNotFoundError extends Error {
  constructor(employeeId: string, date: string) {
    super(`No overtime disposition for employee ${employeeId} on ${date}`);
    this.name = "OvertimeDispositionNotFoundError";
  }
}

// --- Attestation / period locking (status-flow errors, all 409 except the
// missing attestation which is a 404) ---

export class AlreadyAttestedError extends Error {
  constructor() {
    super("The employee is already attested for this period");
    this.name = "AlreadyAttestedError";
  }
}

export class AttestationNotFoundError extends Error {
  constructor(employeeId: string) {
    super(`No attestation for employee ${employeeId} in this period`);
    this.name = "AttestationNotFoundError";
  }
}

// An unstopped attendance session started before the period's end means the
// basis is incomplete — the employee is still "at work" in an ended month.
export class UnfinishedAttendanceError extends Error {
  constructor(employeeId: string) {
    super(`Employee ${employeeId} has an unfinished attendance session in this period`);
    this.name = "UnfinishedAttendanceError";
  }
}

// A period can only be locked once its last day has passed.
export class PeriodNotEndedError extends Error {
  constructor(year: number, month: number) {
    super(`Payroll period ${periodKey(year, month)} has not ended yet`);
    this.name = "PeriodNotEndedError";
  }
}

// Carries the blocking employees' names so the UI can list exactly who is
// missing without re-reading the summary.
export class UnattestedEmployeesError extends Error {
  constructor(readonly names: string[]) {
    super(`The period cannot be locked — not every employee is attested: ${names.join(", ")}`);
    this.name = "UnattestedEmployeesError";
  }
}

export class PeriodNotLockedError extends Error {
  constructor(year: number, month: number) {
    super(`Payroll period ${periodKey(year, month)} is not locked`);
    this.name = "PeriodNotLockedError";
  }
}

// Minutes → pre-formatted Swedish hours string ("8,50") — every row in the
// printable löneunderlag report is formatted here; renderPayrollReport
// itself formats nothing.
function formatReportHours(minutes: number): string {
  return (minutes / 60).toFixed(2).replace(".", ",");
}

// Builds one employee's PDF rows in the report's fixed order, skipping any
// row whose minutes are zero (a printed "0,00" line carries no information).
//
// "Arbetad tid" here is the GROSS workedMinutes — deliberately different
// from the PAXml TID post built in getPaxmlExport below, which is capped at
// schedule time so overtime is never counted twice there. PAXml posts are
// payable line items fed straight into the payroll program; this report is
// a human-readable summary with its own separate payout/comp overtime
// breakdown rows (weekday and weekend each split into utbetalning/komptid),
// so printing the full worked total here is correct, not a double-count.
function payrollReportRows(employee: PeriodEmployeeSummary): { label: string; hours: string }[] {
  const rows: { label: string; hours: string }[] = [];
  const add = (label: string, minutes: number) => {
    if (minutes === 0) return;
    rows.push({ label, hours: formatReportHours(minutes) });
  };
  add("Schemalagd tid", employee.scheduledMinutes);
  add("Arbetad tid", employee.workedMinutes);
  const overtimeComp = employee.overtimeCompMinutes ?? 0;
  const overtimeOffScheduleComp = employee.overtimeOffScheduleCompMinutes ?? 0;
  add("Övertid – utbetalning", employee.overtimeMinutes - overtimeComp);
  add("Övertid – komptid", overtimeComp);
  add("Övertid helg – utbetalning", employee.overtimeOffScheduleMinutes - overtimeOffScheduleComp);
  add("Övertid helg – komptid", overtimeOffScheduleComp);
  for (const absence of employee.absence) add(absence.name, absence.minutes);
  // OB entries carry no separate display name in the current data model —
  // aggregateObMinutes/day.ob only ever carry the register code (same
  // limitation buildPayrollCsv works around by using the code as its column
  // header) — so the code doubles as the row label here too.
  for (const ob of employee.ob) add(ob.code, ob.minutes);
  add("ATF-uttag", employee.atfMinutes);
  add("Ofördelad tid", employee.unaccountedMinutes);
  return rows;
}

// The employee register lives in the timereport module; payroll only needs
// existence checks plus the overtime-compensation default (same structural
// trick as ScheduleService's EmployeeReader) — the timereport repo's
// findEmployeeById returns the full row, which structurally satisfies this
// widened shape without any change on that side.
export interface PayrollEmployeeReader {
  findEmployeeById(id: string): Promise<{ id: string; active: boolean; overtimeCompensation: OvertimeDisposition } | null>;
}

const toMinutes = (clockTime: string) => {
  const [hours, minutes] = clockTime.split(":").map(Number);
  return hours! * 60 + minutes!;
};

function validateObWindow(startTime: string, endTime: string) {
  if (toMinutes(endTime) <= toMinutes(startTime)) {
    throw new InvalidObWindowError(
      "OB window end time must be after its start time (windows may not cross midnight)"
    );
  }
}

// Standard Swedish absence codes with their PAXml tidkod. The register is
// fully editable — this is a starting point, not an authority.
export const STANDARD_ABSENCE_TYPES = [
  { code: "SJK", name: "Sjukfrånvaro", paxmlCode: "SJK" },
  { code: "SEM", name: "Semester", paxmlCode: "SEM" },
  { code: "VAB", name: "Vård av barn", paxmlCode: "VAB" },
  { code: "FPE", name: "Föräldraledig", paxmlCode: "FPE" },
  { code: "TJL", name: "Tjänstledig", paxmlCode: "TJL" },
  { code: "PEM", name: "Permission", paxmlCode: "PEM" },
  { code: "UTB", name: "Utbildning", paxmlCode: "UTB" },
  { code: "KOM", name: "Kompledig", paxmlCode: "KOM" },
] as const;

// Registers + absence bookings, the period summary, attestation and period
// locking — construct it once in app.ts. `employees` reuses the timereport
// module's repository (structurally satisfies PayrollEmployeeReader +
// listEmployees); `periodLocks` is the payroll_periods-backed checker this
// service itself feeds by locking periods. `schedule`/`attendance`/`atf`/
// `settings`/`audit` are satisfied structurally by scheduleService/
// timeReportRepository/the atf repository/systemService/the audit repository.
// `system` is systemService again, narrowed to the company header the PAXml
// export writes (kept separate from `settings` so each stays a minimal Pick).
// `pdf` is the shared document-PDF service, narrowed to the one renderer the
// löneunderlag report needs.
export function createPayrollService(
  repo: PayrollRepository,
  employees: PayrollEmployeeReader & { listEmployees(): Promise<EmployeeRow[]> },
  periodLocks: PeriodLockChecker,
  schedule: {
    resolveEmployeeCalendar(employeeId: string, from: string, to: string): Promise<ResolvedDay[]>;
    listHolidaysInRange(from: string, to: string): Promise<{ date: string }[]>;
  },
  attendance: { listAttendanceSessionsInRange(from: Date, to: Date): Promise<AttendanceRow[]> },
  atf: { listWithdrawalsInRange(from: string, to: string): Promise<AtfRow[]> },
  settings: {
    getSettings(): Promise<{
      payrollOvertimeThresholdMinutes: number;
      // The PAXml tidkoder for the four computed (non-register) time kinds.
      paxmlCodeWorked: string;
      paxmlCodeOvertime: string;
      paxmlCodeOvertimeOffSchedule: string;
      paxmlCodeAtf: string;
      // Overridden per day when that day's overtime is disposed as comp time.
      paxmlCodeOvertimeComp: string;
      paxmlCodeOvertimeOffScheduleComp: string;
    }>;
  },
  audit: AuditWriter,
  system: { getCompanyInfo(): Promise<{ name: string; orgNumber: string | null } | null> },
  pdf: Pick<DocumentPdfService, "renderPayrollReport">
) {
  async function requireEmployee(employeeId: string) {
    const employee = await employees.findEmployeeById(employeeId);
    if (!employee) throw new EmployeeNotFoundError(employeeId);
    return employee;
  }

  // True when the employee has an unstopped attendance session started
  // before the period's end — the same rule the summary's openAttendance
  // flag uses (the range reader itself scopes it), evaluated without
  // building the whole period summary.
  async function hasOpenAttendance(employeeId: string, year: number, month: number) {
    const window = attendanceWindow(periodDates(year, month));
    const sessions = await attendance.listAttendanceSessionsInRange(window.from, window.to);
    return sessions.some((s) => s.employeeId === employeeId && s.stoppedAt === null);
  }

  // A locked period's frozen snapshot, or null while the period is open.
  async function findSnapshot(year: number, month: number): Promise<PeriodSummary | null> {
    const periodRow = await repo.findPayrollPeriod(year, month);
    if (periodRow && periodRow.status === "locked" && periodRow.summary !== null) {
      return periodRow.summary as PeriodSummary;
    }
    return null;
  }

  // Snapshot if the period is locked, otherwise a live computation — the
  // rule behind getPeriodSummary, shared with the CSV export.
  async function loadPeriodSummary(year: number, month: number): Promise<PeriodSummary> {
    return (await findSnapshot(year, month)) ?? computeLivePeriodSummary(year, month);
  }

  // The live computation behind getPeriodSummary. Kept separate so
  // lockPeriod can force a fresh computation (and so getPeriodSummary's
  // snapshot short-circuit sits in exactly one place).
  async function computeLivePeriodSummary(year: number, month: number): Promise<PeriodSummary> {
    const periodRow = await repo.findPayrollPeriod(year, month);
    const { from, to } = periodRange(year, month);
    const dates = periodDates(year, month);
    const { from: attendanceFrom, to: attendanceTo } = attendanceWindow(dates);

    // OB rules, settings and holidays are each fetched once and reused
    // across every employee/day below — they don't vary per employee.
    const [allEmployees, holidayRows, obRuleRows, settingsRow, sessions, atfRows, attestations] = await Promise.all([
      employees.listEmployees(),
      schedule.listHolidaysInRange(from, to),
      repo.listObRules(),
      settings.getSettings(),
      attendance.listAttendanceSessionsInRange(attendanceFrom, attendanceTo),
      atf.listWithdrawalsInRange(from, to),
      periodRow ? repo.listAttestationsForPeriod(periodRow.id) : Promise.resolve([]),
    ]);

    const holidaySet = new Set(holidayRows.map((h) => h.date));
    const obRuleInputs: ObRuleInput[] = obRuleRows.map((r) => ({
      code: r.code,
      paxmlCode: r.paxmlCode,
      dayKind: r.dayKind,
      startTime: r.startTime,
      endTime: r.endTime,
    }));
    const overtimeThresholdMinutes = settingsRow.payrollOvertimeThresholdMinutes;

    const sessionsByEmployee = groupByEmployeeId(sessions);
    const atfByEmployee = groupByEmployeeId(atfRows);
    const attestationByEmployee = new Map(attestations.map((a) => [a.employeeId, a]));

    // Compute every employee's days unconditionally, then filter — the
    // inclusion rule (active OR has data) can only be decided after the
    // period's absences/attendance/ATF are known.
    const built = await Promise.all(
      allEmployees.map(async (employee) => {
        const employeeSessions = sessionsByEmployee.get(employee.id) ?? [];
        const employeeAtf = atfByEmployee.get(employee.id) ?? [];
        const [employeeAbsences, calendar, dispositionRows] = await Promise.all([
          repo.listEmployeeAbsences(employee.id, from, to),
          schedule.resolveEmployeeCalendar(employee.id, from, to),
          repo.listEmployeeOvertimeDispositions(employee.id, from, to),
        ]);
        const dispositionByDate = new Map(dispositionRows.map((r) => [r.date, r.disposition]));

        const days = computeDaysForEmployee({
          dates,
          holidaySet,
          obRuleInputs,
          overtimeThresholdMinutes,
          calendar,
          sessions: employeeSessions,
          atfRows: employeeAtf,
          absenceRows: employeeAbsences,
          defaultDisposition: employee.overtimeCompensation,
          dispositionByDate,
        });

        const attestation = attestationByEmployee.get(employee.id);
        const summary: PeriodEmployeeSummary = {
          employeeId: employee.id,
          employeeNumber: employee.employeeNumber,
          name: employee.name,
          employmentType: employee.employmentType,
          scheduledMinutes: sumBy(days, (d) => d.scheduledMinutes),
          workedMinutes: sumBy(days, (d) => d.workedMinutes),
          absence: aggregateAbsenceMinutes(employeeAbsences),
          ob: aggregateObMinutes(days),
          overtimeMinutes: sumBy(days, (d) => d.overtimeMinutes),
          overtimeOffScheduleMinutes: sumBy(days, (d) => d.overtimeOffScheduleMinutes),
          overtimeCompMinutes: sumBy(
            days.filter((d) => d.overtimeDisposition === "comp"),
            (d) => d.overtimeMinutes
          ),
          overtimeOffScheduleCompMinutes: sumBy(
            days.filter((d) => d.overtimeDisposition === "comp"),
            (d) => d.overtimeOffScheduleMinutes
          ),
          atfMinutes: sumBy(days, (d) => d.atfMinutes),
          unaccountedMinutes: sumBy(days, (d) => d.unaccountedMinutes),
          // Already scoped to sessions started before the period's end by
          // the range query itself, so any open one here counts.
          openAttendance: employeeSessions.some((s) => s.stoppedAt === null),
          attested: attestation !== undefined,
          attestedAt: attestation ? attestation.attestedAt.toISOString() : null,
          attestedByName: attestation?.attestedByName ?? null,
          days,
        };

        const hasData = employeeSessions.length > 0 || employeeAtf.length > 0 || employeeAbsences.length > 0;
        return { summary, include: employee.active || hasData };
      })
    );

    return {
      year,
      month,
      status: periodRow?.status ?? "open",
      lockedAt: periodRow?.lockedAt ? periodRow.lockedAt.toISOString() : null,
      generatedAt: new Date().toISOString(),
      employees: built.filter((b) => b.include).map((b) => b.summary),
    };
  }

  return {
    // --- Frånvarokoder ---

    async listAbsenceTypes(includeInactive = false) {
      return repo.listAbsenceTypes(includeInactive);
    },

    async createAbsenceType(input: CreateAbsenceTypeInput) {
      if (await repo.findAbsenceTypeByCode(input.code)) throw new DuplicatePayrollCodeError("code", input.code);
      if (await repo.findAbsenceTypeByName(input.name)) throw new DuplicatePayrollCodeError("name", input.name);
      return repo.createAbsenceType(input);
    },

    async updateAbsenceType(id: string, input: UpdateAbsenceTypeInput) {
      if (input.code) {
        const byCode = await repo.findAbsenceTypeByCode(input.code);
        if (byCode && byCode.id !== id) throw new DuplicatePayrollCodeError("code", input.code);
      }
      if (input.name) {
        const byName = await repo.findAbsenceTypeByName(input.name);
        if (byName && byName.id !== id) throw new DuplicatePayrollCodeError("name", input.name);
      }
      const row = await repo.updateAbsenceType(id, input);
      if (!row) throw new AbsenceTypeNotFoundError(id);
      return row;
    },

    // Idempotent: creates the standard absence types that are missing and
    // skips the rest, so customized codes/names survive re-runs.
    async seedStandardAbsenceTypes() {
      let created = 0;
      for (const type of STANDARD_ABSENCE_TYPES) {
        if (await repo.createAbsenceTypeIfMissing(type)) created++;
      }
      return { created, skipped: STANDARD_ABSENCE_TYPES.length - created };
    },

    // --- Avvikelseorsaker ---

    async listAttendanceDeviationReasons(includeInactive = false) {
      return repo.listAttendanceDeviationReasons(includeInactive);
    },

    async createAttendanceDeviationReason(input: CreateAttendanceDeviationReasonInput) {
      if (await repo.findAttendanceDeviationReasonByCode(input.code)) {
        throw new DuplicatePayrollCodeError("code", input.code);
      }
      if (await repo.findAttendanceDeviationReasonByName(input.name)) {
        throw new DuplicatePayrollCodeError("name", input.name);
      }
      return repo.createAttendanceDeviationReason(input);
    },

    async updateAttendanceDeviationReason(id: string, input: UpdateAttendanceDeviationReasonInput) {
      if (input.code) {
        const byCode = await repo.findAttendanceDeviationReasonByCode(input.code);
        if (byCode && byCode.id !== id) throw new DuplicatePayrollCodeError("code", input.code);
      }
      if (input.name) {
        const byName = await repo.findAttendanceDeviationReasonByName(input.name);
        if (byName && byName.id !== id) throw new DuplicatePayrollCodeError("name", input.name);
      }
      const row = await repo.updateAttendanceDeviationReason(id, input);
      if (!row) throw new AttendanceDeviationReasonNotFoundError(id);
      return row;
    },

    // --- OB-regler ---

    async listObRules(includeInactive = false) {
      return repo.listObRules(includeInactive);
    },

    async createObRule(input: CreateObRuleInput) {
      validateObWindow(input.startTime, input.endTime);
      if (await repo.findObRuleByCode(input.code)) throw new DuplicatePayrollCodeError("code", input.code);
      if (await repo.findObRuleByName(input.name)) throw new DuplicatePayrollCodeError("name", input.name);
      return repo.createObRule(input);
    },

    async updateObRule(id: string, input: UpdateObRuleInput) {
      if (input.startTime || input.endTime) {
        const existing = await repo.findObRuleById(id);
        if (!existing) throw new ObRuleNotFoundError(id);
        validateObWindow(input.startTime ?? existing.startTime, input.endTime ?? existing.endTime);
      }
      if (input.code) {
        const byCode = await repo.findObRuleByCode(input.code);
        if (byCode && byCode.id !== id) throw new DuplicatePayrollCodeError("code", input.code);
      }
      if (input.name) {
        const byName = await repo.findObRuleByName(input.name);
        if (byName && byName.id !== id) throw new DuplicatePayrollCodeError("name", input.name);
      }
      const row = await repo.updateObRule(id, input);
      if (!row) throw new ObRuleNotFoundError(id);
      return row;
    },

    // --- Frånvaro (absence bookings) ---

    async listEmployeeAbsences(employeeId: string, from?: string, to?: string) {
      await requireEmployee(employeeId);
      return repo.listEmployeeAbsences(employeeId, from, to);
    },

    async createAbsence(employeeId: string, input: CreateAbsenceInput, userId: string) {
      await requireEmployee(employeeId);
      const type = await repo.findAbsenceTypeById(input.absenceTypeId);
      if (!type) throw new AbsenceTypeNotFoundError(input.absenceTypeId);
      if (!type.active) throw new InactiveAbsenceTypeError(input.absenceTypeId);

      if (await periodLocks.isDateLocked(input.date)) throw new PayrollPeriodLockedError(input.date);

      let row;
      try {
        row = await repo.createAbsence(employeeId, input, userId);
      } catch (err) {
        if (isUniqueViolation(err)) throw new DuplicateAbsenceError();
        throw err;
      }

      await audit.log({
        entityType: "absence",
        entityId: row.id,
        action: "created",
        detail: { employeeId, date: row.date, absenceTypeId: row.absenceTypeId, minutes: row.minutes },
        userId,
      });
      return row;
    },

    async deleteAbsence(id: string, userId: string) {
      const existing = await repo.findAbsenceById(id);
      if (!existing) throw new AbsenceNotFoundError(id);

      if (await periodLocks.isDateLocked(existing.date)) throw new PayrollPeriodLockedError(existing.date);

      const row = await repo.deleteAbsence(id);
      if (!row) throw new AbsenceNotFoundError(id);

      await audit.log({
        entityType: "absence",
        entityId: row.id,
        action: "deleted",
        detail: {
          employeeId: row.employeeId,
          date: row.date,
          absenceTypeId: row.absenceTypeId,
          minutes: row.minutes,
        },
        userId,
      });
      return row;
    },

    // --- Övertidsdispositioner (per-dag-avvikelse från personalkortets default) ---

    async setOvertimeDisposition(employeeId: string, date: string, disposition: OvertimeDisposition, userId: string) {
      await requireEmployee(employeeId);
      if (await periodLocks.isDateLocked(date)) throw new PayrollPeriodLockedError(date);
      const row = await repo.upsertOvertimeDisposition(employeeId, date, disposition, userId);
      await audit.log({
        entityType: "overtime_disposition",
        entityId: row.id,
        action: "set",
        detail: { employeeId, date, disposition },
        userId,
      });
      return row;
    },

    async clearOvertimeDisposition(employeeId: string, date: string, userId: string) {
      await requireEmployee(employeeId);
      if (await periodLocks.isDateLocked(date)) throw new PayrollPeriodLockedError(date);
      const row = await repo.deleteOvertimeDisposition(employeeId, date);
      if (!row) throw new OvertimeDispositionNotFoundError(employeeId, date);
      await audit.log({
        entityType: "overtime_disposition",
        entityId: row.id,
        action: "cleared",
        detail: { employeeId, date, disposition: row.disposition },
        userId,
      });
    },

    // --- Löneperiod-sammanställning (period summary) ---

    // A locked period with a captured snapshot always wins — the basis is
    // frozen at lock time and must never silently drift if attendance/absence
    // rows are edited afterwards (edits to locked dates are rejected anyway
    // by the period-lock guard above, but this also covers e.g. a schedule
    // change made after the fact).
    async getPeriodSummary(year: number, month: number): Promise<PeriodSummary> {
      return loadPeriodSummary(year, month);
    },

    // --- Export av löneunderlag ---

    // PAXml file for the payroll program. Locked periods only: the export is
    // what payroll is actually run on, so it must come from the frozen
    // snapshot and never from a basis that can still move.
    async getPaxmlExport(year: number, month: number, userId: string) {
      const summary = await findSnapshot(year, month);
      if (summary === null) throw new PeriodNotLockedError(year, month);

      const [settingsRow, company, employeeRows] = await Promise.all([
        settings.getSettings(),
        system.getCompanyInfo(),
        employees.listEmployees(),
      ]);
      // The snapshot carries no personnummer (it is not part of the basis) —
      // it is read live from the employee register.
      const personalIdentityNumbers = new Map(
        employeeRows.map((row) => [row.id, row.personalIdentityNumber ?? null])
      );

      let postCount = 0;
      const paxmlEmployees: PaxmlEmployeeInput[] = summary.employees.map((employee) => {
        const days = employee.days.map((day) => {
          const posts: PaxmlPost[] = [];
          // Monthly-paid employees are not paid per reported hour, so their
          // worked time is not payroll input — their absences, overtime, OB
          // and ATF withdrawals still are.
          //
          // The worked post is time WITHIN the schedule: the standard defines
          // TID as "Arbetstid (arbetstid inom schematid)", and the overtime
          // posts below carry the rest. Sending the day engine's full
          // workedMinutes here would report the overtime hours twice — once as
          // worked time and once as overtime. Off-schedule days route every
          // worked minute to overtimeOffScheduleMinutes, so they correctly
          // produce no worked post at all.
          if (employee.employmentType === "hourly") {
            const withinSchedule = Math.max(
              0,
              day.workedMinutes - day.overtimeMinutes - day.overtimeOffScheduleMinutes
            );
            posts.push({ code: settingsRow.paxmlCodeWorked, hours: withinSchedule / 60 });
          }
          for (const absence of day.absences) posts.push({ code: absence.paxmlCode, hours: absence.minutes / 60 });
          for (const ob of day.ob) posts.push({ code: ob.paxmlCode, hours: ob.minutes / 60 });

          // Pre-feature snapshots (locked before this field existed) lack it
          // at runtime despite the compile-time PayrollDay type — normalize
          // before reading, same as the getEmployeePeriodDays snapshot branch.
          const disposition = normalizePayrollDay(day).overtimeDisposition;
          posts.push({
            code: disposition === "comp" ? settingsRow.paxmlCodeOvertimeComp : settingsRow.paxmlCodeOvertime,
            hours: day.overtimeMinutes / 60,
          });
          posts.push({
            code:
              disposition === "comp"
                ? settingsRow.paxmlCodeOvertimeOffScheduleComp
                : settingsRow.paxmlCodeOvertimeOffSchedule,
            hours: day.overtimeOffScheduleMinutes / 60,
          });
          posts.push({ code: settingsRow.paxmlCodeAtf, hours: day.atfMinutes / 60 });

          // A zero-hour post carries no information and would only add noise
          // to the payroll program's import log.
          const nonZero = posts.filter((post) => post.hours > 0);
          postCount += nonZero.length;
          return { date: day.date, posts: nonZero };
        });

        return {
          employeeNumber: employee.employeeNumber,
          personalIdentityNumber: personalIdentityNumbers.get(employee.employeeId) ?? null,
          days,
        };
      });

      const content = buildPaxmlXml({
        orgNo: company?.orgNumber ?? null,
        companyName: company?.name ?? null,
        exportDate: new Date().toISOString(),
        employees: paxmlEmployees,
      });

      await audit.log({
        entityType: "payroll_period",
        entityId: periodKey(year, month),
        action: "paxml_exported",
        detail: { employeeCount: summary.employees.length, postCount },
        userId,
      });

      return { filename: `paxml-${periodKey(year, month)}.xml`, content: Buffer.from(content, "utf8") };
    },

    // CSV overview of the same basis. Unlike PAXml this is allowed on an open
    // period — it is a preview the payroll admin checks *before* locking.
    async getCsvExport(year: number, month: number) {
      const summary = await loadPeriodSummary(year, month);
      return {
        filename: `loneunderlag-${periodKey(year, month)}.csv`,
        content: buildPayrollCsv(summary),
      };
    },

    // Printable löneunderlag PDF — same basis as the CSV/summary (the frozen
    // snapshot once locked, a live computation otherwise), one section per
    // employee for a supervisor to review or hand out on paper. Unlike
    // getPaxmlExport this is allowed on an open period, same as the CSV.
    async getPayrollPdf(year: number, month: number) {
      const summary = await loadPeriodSummary(year, month);
      const status = summary.lockedAt
        ? `Låst ${localDateString(new Date(summary.lockedAt))}`
        : "Ej låst (preliminärt)";

      const content = await pdf.renderPayrollReport({
        periodLabel: `Löneunderlag ${MONTH_NAMES_SV[month - 1]} ${year}`,
        status,
        employees: summary.employees.map((employee) => ({
          employeeNumber: employee.employeeNumber,
          name: employee.name,
          employmentTypeLabel: employee.employmentType
            ? EMPLOYMENT_TYPE_LABELS[employee.employmentType]
            : "Ej angiven",
          rows: payrollReportRows(employee),
        })),
      });

      return { filename: `loneunderlag-${periodKey(year, month)}.pdf`, content };
    },

    // --- Attestering ---

    // Attest one employee's basis for a period. The period row is created
    // lazily here (first attestation of the month materializes it).
    async attest(year: number, month: number, employeeId: string, userId: string) {
      await requireEmployee(employeeId);

      const period = await repo.ensurePayrollPeriod(year, month);
      const { from } = periodRange(year, month);
      if (period.status === "locked") throw new PayrollPeriodLockedError(from);

      // An employee still clocked in has an incomplete basis — attesting it
      // would freeze a number that is going to change.
      if (await hasOpenAttendance(employeeId, year, month)) throw new UnfinishedAttendanceError(employeeId);

      let attestation;
      try {
        attestation = await repo.createAttestation(period.id, employeeId, userId);
      } catch (err) {
        if (isUniqueViolation(err)) throw new AlreadyAttestedError();
        throw err;
      }

      await audit.log({
        entityType: "payroll_attestation",
        entityId: attestation.id,
        action: "attested",
        detail: { employeeId, year, month },
        userId,
      });
    },

    // Undo an attestation (only while the period is still open).
    async unattest(year: number, month: number, employeeId: string, userId: string) {
      const period = await repo.findPayrollPeriod(year, month);
      const { from } = periodRange(year, month);
      if (period?.status === "locked") throw new PayrollPeriodLockedError(from);
      if (!period) throw new AttestationNotFoundError(employeeId);

      const row = await repo.deleteAttestation(period.id, employeeId);
      if (!row) throw new AttestationNotFoundError(employeeId);

      await audit.log({
        entityType: "payroll_attestation",
        entityId: row.id,
        action: "unattested",
        detail: { employeeId, year, month },
        userId,
      });
    },

    // --- Låsning av löneperiod ---

    // Freeze the period: computes the basis one last time, stores it verbatim
    // as the snapshot every later read is served from, and blocks all writes
    // to dates inside the month (via PeriodLockChecker).
    async lockPeriod(year: number, month: number, userId: string): Promise<PeriodSummary> {
      const { from, to } = periodRange(year, month);
      // Locking a period that is still running would freeze a basis that is
      // still being reported into.
      if (to >= localToday()) throw new PeriodNotEndedError(year, month);

      const period = await repo.ensurePayrollPeriod(year, month);
      if (period.status === "locked") throw new PayrollPeriodLockedError(from);

      const summary = await computeLivePeriodSummary(year, month);
      // Open attendance blocks attestation too, so an employee flagged here
      // can never also be attested — both belong in the same blocker list.
      const blockers = summary.employees.filter((e) => !e.attested || e.openAttendance).map((e) => e.name);
      if (blockers.length > 0) throw new UnattestedEmployeesError(blockers);

      const lockedAt = new Date();
      // The stored JSON must stand on its own: getPeriodSummary hands it back
      // verbatim, so its own status/lockedAt have to describe the locked
      // period rather than the open one it was computed from. Shallow copy —
      // the engine's arrays are never mutated (see payroll-day.ts).
      const snapshot: PeriodSummary = { ...summary, status: "locked", lockedAt: lockedAt.toISOString() };

      await repo.lockPayrollPeriod(period.id, snapshot, lockedAt, userId);
      await audit.log({
        entityType: "payroll_period",
        entityId: periodKey(year, month),
        action: "locked",
        detail: { year, month, employeeCount: snapshot.employees.length },
        userId,
      });

      return snapshot;
    },

    // Reopen a locked period: drops the snapshot (the summary is computed
    // live again) and lets writes back in. Attestations are kept.
    async unlockPeriod(year: number, month: number, userId: string) {
      const period = await repo.findPayrollPeriod(year, month);
      if (!period || period.status !== "locked") throw new PeriodNotLockedError(year, month);

      await repo.unlockPayrollPeriod(period.id);
      await audit.log({
        entityType: "payroll_period",
        entityId: periodKey(year, month),
        action: "unlocked",
        detail: { year, month },
        userId,
      });
    },

    // Per-employee day detail plus the raw session/absence rows the
    // correction UI needs (e.g. to let a supervisor add a missing stamp).
    // Reuses the same per-day computation as getPeriodSummary.
    //
    // Locked periods serve `days` from the stored snapshot, exactly like
    // getPeriodSummary — otherwise this endpoint would recompute live and
    // could disagree with the frozen basis (e.g. after a schedule change).
    // The raw session/absence rows stay live: they are the correction UI's
    // input, and every correction into a locked period is rejected anyway.
    async getEmployeePeriodDays(employeeId: string, year: number, month: number) {
      const employee = await requireEmployee(employeeId);

      const { from, to } = periodRange(year, month);
      const dates = periodDates(year, month);
      const { from: attendanceFrom, to: attendanceTo } = attendanceWindow(dates);

      const periodRow = await repo.findPayrollPeriod(year, month);
      const snapshot =
        periodRow && periodRow.status === "locked" && periodRow.summary !== null
          ? (periodRow.summary as PeriodSummary)
          : null;

      const [calendar, holidayRows, obRuleRows, settingsRow, allSessions, allAtf, employeeAbsences, dispositionRows] =
        await Promise.all([
          schedule.resolveEmployeeCalendar(employeeId, from, to),
          schedule.listHolidaysInRange(from, to),
          repo.listObRules(),
          settings.getSettings(),
          attendance.listAttendanceSessionsInRange(attendanceFrom, attendanceTo),
          atf.listWithdrawalsInRange(from, to),
          repo.listEmployeeAbsences(employeeId, from, to),
          repo.listEmployeeOvertimeDispositions(employeeId, from, to),
        ]);
      const dispositionByDate = new Map(dispositionRows.map((r) => [r.date, r.disposition]));

      // The range readers cover every employee — no per-employee variant
      // exists (see the two new repo methods), so filter down here.
      const sessions = allSessions.filter((s) => s.employeeId === employeeId);
      const atfRows = allAtf.filter((a) => a.employeeId === employeeId);

      const holidaySet = new Set(holidayRows.map((h) => h.date));
      const obRuleInputs: ObRuleInput[] = obRuleRows.map((r) => ({
        code: r.code,
        paxmlCode: r.paxmlCode,
        dayKind: r.dayKind,
        startTime: r.startTime,
        endTime: r.endTime,
      }));

      // An employee missing from the snapshot was not part of the locked
      // basis (excluded as inactive-without-data), so they have no frozen
      // days to show. Snapshot days are normalized so a pre-feature snapshot
      // (locked before this feature existed) still hands the UI both fields.
      const days = snapshot
        ? (snapshot.employees.find((e) => e.employeeId === employeeId)?.days ?? []).map(normalizePayrollDay)
        : computeDaysForEmployee({
            dates,
            holidaySet,
            obRuleInputs,
            overtimeThresholdMinutes: settingsRow.payrollOvertimeThresholdMinutes,
            calendar,
            sessions,
            atfRows,
            absenceRows: employeeAbsences,
            defaultDisposition: employee.overtimeCompensation,
            dispositionByDate,
          });

      return {
        days,
        sessions: sessions.map((s) => ({
          id: s.id,
          date: localDateString(s.startedAt),
          startedAt: s.startedAt.toISOString(),
          stoppedAt: s.stoppedAt ? s.stoppedAt.toISOString() : null,
        })),
        absences: employeeAbsences.map((a) => ({
          id: a.id,
          date: a.date,
          code: a.absenceTypeCode,
          name: a.absenceTypeName,
          minutes: a.minutes,
          note: a.note,
        })),
      };
    },
  };
}

export type PayrollService = ReturnType<typeof createPayrollService>;
