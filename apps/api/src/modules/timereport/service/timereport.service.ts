import type {
  AttendanceInInput,
  AttendanceOutInput,
  AttendanceReasonInput,
  OvertimeDisposition,
  CreateEmployeeInput,
  CreateTimeReportInput,
  ListQuery,
  StampInInput,
  StampOutInput,
  UpdateAttendanceSessionInput,
  UpdateEmployeeInput,
  UpdateTimeReportInput,
} from "@navet/shared";
import type { Tx } from "@navet/db";
import type { StampReason, TimeReportRepository } from "../repository/timereport.repository.js";
import { localDateOf, stampedHours } from "../repository/stamp-close.js";
import type { ManufacturingService } from "../../manufacturing/service/manufacturing.service.js";
import {
  InvalidStatusTransitionError,
  MOOperationNotFoundError,
  WorkCenterNotFoundError,
} from "../../manufacturing/service/manufacturing.service.js";
// Leaf file in the payroll module — no import cycle (see period-lock.ts).
import { PayrollPeriodLockedError, type PeriodLockChecker } from "../../payroll/service/period-lock.js";
import type { AuditWriter } from "../../system/repository/audit.repository.js";
import { erasurePlan, type ErasureBlocker } from "./employee-erasure-plan.js";
import { isForeignKeyViolation, isUniqueViolation } from "../../system/service/db-errors.js";
import {
  AtfTransactionMismatchError,
  AttendanceInputRequiredError,
  AttendanceReasonInvalidError,
  assessArrival,
  assessDeparture,
  scheduledWindow,
  type DeviationDaySchedule,
  type OvertimeQuestion,
} from "./attendance-deviation.js";

export class EmployeeNotFoundError extends Error {
  constructor(id: string) {
    super(`Employee ${id} not found`);
    this.name = "EmployeeNotFoundError";
  }
}

// GDPR (#2): something still in play blocks Radera/Anonymisera — the
// employee is active, has an open session, or has time in an unlocked
// payroll month. 409 employee-erasure-blocked, with the blockers.
export class EmployeeErasureBlockedError extends Error {
  constructor(public blockers: ErasureBlocker[]) {
    super(`Employee cannot be erased yet: ${blockers.map((b) => b.code).join(", ")}`);
    this.name = "EmployeeErasureBlockedError";
  }
}

// Radera is only for an employee who never stamped or got paid; one with
// history is anonymized instead. 409 employee-has-history.
export class EmployeeHasHistoryError extends Error {
  constructor(id: string) {
    super(`Employee ${id} has time or payroll history and can only be anonymized`);
    this.name = "EmployeeHasHistoryError";
  }
}

// An anonymized employee is frozen. 409 employee-anonymized — the same code
// the guard triggers (SQLSTATE NV002) map to.
export class EmployeeAnonymizedError extends Error {
  constructor(id: string) {
    super(`Employee ${id} is anonymized and cannot change`);
    this.name = "EmployeeAnonymizedError";
  }
}

export class InactiveEmployeeError extends Error {
  constructor() {
    super("Employee is inactive and cannot stamp in");
    this.name = "InactiveEmployeeError";
  }
}

export class AlreadyStampedInError extends Error {
  constructor() {
    super("Employee already has an open stamp session on this operation");
    this.name = "AlreadyStampedInError";
  }
}

export class StampSessionNotFoundError extends Error {
  constructor(id: string) {
    super(`Stamp session ${id} not found`);
    this.name = "StampSessionNotFoundError";
  }
}

export class StampSessionAlreadyStoppedError extends Error {
  constructor() {
    super("Stamp session is already stopped");
    this.name = "StampSessionAlreadyStoppedError";
  }
}

export class DuplicateEmployeeNumberError extends Error {
  constructor(employeeNumber: string) {
    super(`An employee with number "${employeeNumber}" already exists`);
    this.name = "DuplicateEmployeeNumberError";
  }
}

export class AlreadyPresentError extends Error {
  constructor() {
    super("Employee is already clocked in as present");
    this.name = "AlreadyPresentError";
  }
}

// Regel 8: the terminal asks when the employee went home before it opens
// today's attendance (attendanceIn with forgottenStoppedAt).
export class AttendanceOpenFromEarlierDayError extends Error {
  constructor(
    readonly attendanceSessionId: string,
    readonly startedAt: Date
  ) {
    super("The employee's attendance has been open since an earlier day — say when they went home");
    this.name = "AttendanceOpenFromEarlierDayError";
  }
}

export class AttendanceSessionNotFoundError extends Error {
  constructor(id: string) {
    super(`Attendance session ${id} not found`);
    this.name = "AttendanceSessionNotFoundError";
  }
}

export class AttendanceSessionAlreadyStoppedError extends Error {
  constructor() {
    super("Attendance session is already stopped");
    this.name = "AttendanceSessionAlreadyStoppedError";
  }
}

// A supervisor's correction lost the race against a stamp (typically Gå hem
// at the terminal) that changed the session's stop time after it was read —
// nothing is written; the correction is made again on the fresh session.
export class AttendanceSessionChangedError extends Error {
  constructor(id: string) {
    super(`Attendance session ${id} was changed while it was being corrected`);
    this.name = "AttendanceSessionChangedError";
  }
}

export class InvalidAttendanceIntervalError extends Error {
  constructor() {
    super("Stopped time must be after started time");
    this.name = "InvalidAttendanceIntervalError";
  }
}

export class InvalidStopTimeError extends Error {
  constructor() {
    super("Stop time must be after the stamp's start and not in the future");
    this.name = "InvalidStopTimeError";
  }
}

export class StopTimeNotAllowedError extends Error {
  constructor() {
    super("Only a supervisor or admin can set the stop time");
    this.name = "StopTimeNotAllowedError";
  }
}

export class TimeReportNotFoundError extends Error {
  constructor(id: string) {
    super(`Time report ${id} not found`);
    this.name = "TimeReportNotFoundError";
  }
}

// Lives here rather than in schedule.service.ts so the import direction stays
// one-way (schedule.service imports from this file, never the reverse) — the
// employee PATCH below needs it for defaultWeekScheduleId validation.
export class WeekScheduleNotFoundError extends Error {
  constructor(id: string) {
    super(`Week schedule ${id} not found`);
    this.name = "WeekScheduleNotFoundError";
  }
}

// The day's overtime choice, written inside Gå hem's own transaction — the
// payroll repository's upsertOvertimeDispositionInTx (Db | Tx).
export interface OvertimeDispositionWriter {
  upsert(tx: Tx, employeeId: string, date: string, disposition: OvertimeDisposition, createdBy: string): Promise<{ id: string }>;
}

// Närvaroavvikelser: what the attendance stamps need to ask for a reason and
// an overtime choice. Optional — without it nothing is checked or asked
// (the fixtures and older callers keep today's behaviour). Wired in app.ts:
// settings = systemService, calendar = scheduleService, previewDay =
// payrollService.previewDay, dispositionWriter = the payroll repository.
export interface AttendanceDeviationDeps {
  settings: {
    getSettings(): Promise<{
      attendanceReasonRequired: boolean;
      attendanceReasonToleranceMinutes: number;
      terminalOvertimeChoice: boolean;
    }>;
  };
  calendar: {
    resolveEmployeeCalendar(
      employeeId: string,
      from: string,
      to: string
    ): Promise<{ date: string; daySchedule: DeviationDaySchedule | null }[]>;
  };
  // The payroll day as it would be with the open attendance closed at
  // `closeOpenAt` — lönens egen computeEmployeeDay, nothing written.
  previewDay(
    employeeId: string,
    date: string,
    opts: { closeOpenAt: Date }
  ): Promise<{ overtimeMinutes: number; overtimeOffScheduleMinutes: number; overtimeDisposition: OvertimeDisposition }>;
  dispositionWriter: OvertimeDispositionWriter;
  // Test seam (like the planning service's `today`): the instant attendance
  // stamps happen at. Defaults to the wall clock.
  now?: () => Date;
  // Where a failing deviation check is reported (app.log in app.ts;
  // console.error when left out). The check never fails a stamp.
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

const toStampReason = (reason: AttendanceReasonInput | undefined): StampReason =>
  reason ? { reasonId: reason.reasonId, note: reason.note ? reason.note : null } : { reasonId: null, note: null };

export function createTimeReportService(
  repo: TimeReportRepository,
  manufacturing: ManufacturingService,
  periodLocks: PeriodLockChecker,
  audit: AuditWriter,
  deviations?: AttendanceDeviationDeps
) {
  const clock = deviations?.now ?? (() => new Date());

  // A reason must exist and be active to be chosen at the terminal
  // (inactive ones stay on old sessions as history).
  async function assertActiveReason(reasonId: string) {
    const reason = await repo.findAttendanceDeviationReason(reasonId);
    if (!reason || !reason.active) throw new AttendanceReasonInvalidError(reasonId);
  }

  // Radera (no history) or Anonymisera (history), decided again inside the
  // repository's transaction with the employee row locked. The log names the
  // employee number only — never the name.
  async function erase(id: string, wanted: "delete" | "anonymize", userId: string) {
    const result = await repo.eraseEmployee(id, (employee, facts) => {
      const plan = erasurePlan(employee, facts);
      if (plan.action === "anonymized") throw new EmployeeAnonymizedError(id);
      if (wanted === "delete" && plan.action === "anonymize") throw new EmployeeHasHistoryError(id);
      if (plan.blockers.length > 0) throw new EmployeeErasureBlockedError(plan.blockers);
      return wanted;
    });
    if (!result) throw new EmployeeNotFoundError(id);
    await audit.log({
      entityType: "employee",
      entityId: id,
      action: result.action === "delete" ? "deleted" : "anonymized",
      detail: { employeeNumber: result.employee.employeeNumber, auditEntriesScrubbed: result.auditEntriesScrubbed },
      userId,
    });
    return { action: result.action };
  }

  async function scheduleOn(employeeId: string, date: string) {
    const [day] = await deviations!.calendar.resolveEmployeeCalendar(employeeId, date, date);
    return day?.daySchedule ?? null;
  }

  // A stamp must never fail because the deviation check did: a failing
  // lookup (schedule, payroll preview, settings) is logged and the question
  // is skipped — the attestation still shows the deviation afterwards.
  async function deviationCheck<T>(what: string, employeeId: string, fallback: T, check: () => Promise<T>): Promise<T> {
    try {
      return await check();
    } catch (err) {
      const extra = { employeeId, err: err instanceof Error ? { name: err.name, message: err.message } : String(err) };
      if (deviations?.log) deviations.log(`Närvaroavvikelser: ${what} failed — question skipped`, extra);
      else console.error(`Närvaroavvikelser: ${what} failed — question skipped`, extra);
      return fallback;
    }
  }

  // Sen ankomst: asked before anything is written. Only with the setting on,
  // no reason sent, an open payroll period, and only when this attendance
  // becomes the day's first presence in the schedule window (payroll's
  // rule — assessArrival). `closing` is the forgotten attendance that
  // closeForgottenAndBegin closes at `stop` in the same transaction: it is
  // judged with that stop time instead of as still open.
  async function assertArrivalReason(
    employeeId: string,
    at: Date,
    reason: AttendanceReasonInput | undefined,
    closing?: { id: string; startedAt: Date; stop: Date }
  ) {
    if (!deviations || reason) return;
    const date = localDateOf(at);
    const late = await deviationCheck("sen ankomst", employeeId, null, async () => {
      const settings = await deviations.settings.getSettings();
      if (!settings.attendanceReasonRequired) return null;
      if (await periodLocks.isDateLocked(date)) return null;
      const schedule = await scheduleOn(employeeId, date);
      const window = scheduledWindow(date, schedule);
      if (!window || at.getTime() >= window.end) return null;
      const from = new Date(window.start);
      const to = new Date(window.end);
      const earlierPresenceInWindow =
        (closing !== undefined && closing.startedAt < to && closing.stop > from) ||
        (await repo.hasAttendanceInWindow(employeeId, from, to, closing?.id));
      return assessArrival({ date, schedule, at, earlierPresenceInWindow, settings });
    });
    if (late?.requiresReason) {
      throw new AttendanceInputRequiredError({ kind: late.kind, minutes: late.minutes, scheduledTime: late.scheduledTime }, null);
    }
  }

  // Regel 5 shares this with attendanceIn: resume work paused by the
  // previous Gå hem, then open the attendance (with its sen ankomst reason).
  async function beginAttendance(employeeId: string, createdBy: string, at: Date, reason?: AttendanceReasonInput) {
    await repo.resumeStampSessions(employeeId, at);
    return repo.createAttendanceSession(employeeId, createdBy, toStampReason(reason), at);
  }

  // Stämpla ut: closes the session, materializes the time report and
  // reports the stint's quantities on the operation. (Going home no longer
  // comes through here — attendanceOut pauses open work stamps instead.)
  async function doStampOut(sessionId: string, input: StampOutInput, createdBy: string) {
    const session = await repo.findStampSessionById(sessionId);
    if (!session) throw new StampSessionNotFoundError(sessionId);
    if (session.stoppedAt) throw new StampSessionAlreadyStoppedError();

    // Regel 6: a supervisor can say when the stint actually ended. Without
    // one the stint ends now and the report lands on today, as before.
    const now = new Date();
    const stoppedAt = input.stoppedAt ? new Date(input.stoppedAt) : now;
    if (input.stoppedAt) {
      // One minute of slack for clock skew between browser and server.
      if (stoppedAt <= session.startedAt || stoppedAt.getTime() > now.getTime() + 60_000) {
        throw new InvalidStopTimeError();
      }
      if (await periodLocks.isDateLocked(localDateOf(stoppedAt))) throw new PayrollPeriodLockedError(localDateOf(stoppedAt));
    }

    // Every stamp-out reports the stint's quantities (OK + scrapped, both
    // possibly 0). Scrapped units also draw the operation's linked material.
    const quantityOk = input.quantityOk ?? 0;
    const quantityScrapped = input.quantityScrapped ?? 0;
    const hasQuantities = quantityOk > 0 || quantityScrapped > 0;
    const markDone = input.markOperationDone ?? false;

    // Materialbrist: the time report and the closed session below are
    // separate operations from the quantity report, so a report refused
    // inside its own transaction would leave the person stamped out with
    // nothing reported. The exact report is dry-run first, while nothing is
    // written; only a stint with quantities draws anything.
    if (hasQuantities) {
      await manufacturing.assertMaterialBeforeOperationReport(
        session.moOperationId,
        { quantityOk, quantityScrapped, scrapReason: input.scrapReason, scrapReasonId: input.scrapReasonId, markDone, employeeId: session.employeeId, createdBy },
        input.allowMaterialShortage
      );
    }

    // Paused time (away from work, e.g. gone home overnight) is excluded
    // from the reported hours; an ongoing pause counts up to stoppedAt.
    const hours = stampedHours(session, stoppedAt);

    // Dated on the stop time's local day (localDateOf, shared with the
    // automatic stamp-out) — a stint stopped just before midnight lands on
    // the day the work was done.
    const report = await repo.createTimeReport(
      { employeeId: session.employeeId, moOperationId: session.moOperationId, date: localDateOf(stoppedAt), hours, note: input.note },
      createdBy
    );
    const closed = await repo.closeStampSession(sessionId, stoppedAt, report.id);
    if (!closed) {
      // Stamped out underneath us (the operation turned done and regel 10
      // closed every stamp on it) — that close already reported the time.
      await repo.deleteTimeReport(report.id);
      throw new StampSessionAlreadyStoppedError();
    }

    // Pallkort: the mo_reports row this stamp-out wrote, so the terminal can
    // print the REPORT's card (date + reporter) rather than the operation's.
    let reportId: string | null = null;
    if (hasQuantities || markDone) {
      const totalHours = markDone ? await repo.sumReportedHoursForOperation(session.moOperationId) : undefined;
      const reported = await manufacturing.reportOperationQuantities(session.moOperationId, {
        quantityOk,
        quantityScrapped,
        scrapReason: input.scrapReason,
        scrapReasonId: input.scrapReasonId,
        actualTime: totalHours,
        markDone,
        employeeId: session.employeeId,
        createdBy: createdBy,
        source: "terminal",
        timeReportId: report.id,
        // The dry run above already answered; the session is closed and the
        // time report written, so this report must not be refused. Stock
        // can go negative through another report landing in between —
        // accepted (see assertMaterialBeforeOperationReport).
        materialShortageChecked: hasQuantities,
      });
      reportId = reported.reportId;
    } else {
      // Nothing to report, but the stamp is still a report row on the TO
      // card, so its time can be undone there too.
      const timeOnly = await manufacturing.logTimeOnlyReport(session.moOperationId, {
        timeReportId: report.id,
        employeeId: session.employeeId,
        createdBy,
      });
      reportId = timeOnly?.id ?? null;
    }

    return { session: closed, timeReport: report, reportId };
  }

  return {
    async createEmployee(input: CreateEmployeeInput) {
      return repo.createEmployee(input);
    },

    async getEmployee(id: string) {
      const row = await repo.findEmployeeById(id);
      if (!row) return null;
      const defaults = await repo.workCenterIdsByEmployee([id]);
      return { ...row, defaultWorkCenterIds: defaults.get(id) ?? [] };
    },

    async listEmployees() {
      return repo.listEmployees();
    },

    // Personalkatalog — names, numbers and Förvalda stationer only, for the
    // shop floor.
    async listEmployeeDirectory() {
      const [list, defaults] = await Promise.all([repo.listEmployeeDirectory(), repo.workCenterIdsByEmployee()]);
      // Förvalda stationer ride along so the terminal can preselect them.
      const rows = list.map((row) => ({ ...row, defaultWorkCenterIds: defaults.get(row.id) ?? [] }));
      return rows.sort((a, b) => a.employeeNumber.localeCompare(b.employeeNumber, "sv", { numeric: true }));
    },

    // Manually entered time report. Stamp-outs go through doStampOut instead
    // and land on the stop time's day: today (which can never sit inside a
    // locked period — a period is only lockable once its last day has
    // passed) or a supervisor's stop time, checked there.
    async createTimeReport(input: CreateTimeReportInput, createdBy: string) {
      if (await periodLocks.isDateLocked(input.date)) throw new PayrollPeriodLockedError(input.date);
      return repo.createTimeReport(input, createdBy);
    },

    async listTimeReports(query: ListQuery) {
      return repo.listTimeReports(query);
    },

    async listTimeReportsByManufacturingOrder(manufacturingOrderId: string) {
      return repo.listTimeReportsByManufacturingOrder(manufacturingOrderId);
    },

    // Frånvaro is health data: absentToday only reaches admin/supervisor
    // (the route decides), everyone else gets rows without the key.
    async listStampSessions(onlyOpen: boolean, opts: { employeeId?: string; includeAbsence?: boolean } = {}) {
      const rows = await repo.listStampSessions(onlyOpen, {
        employeeId: opts.employeeId,
        absenceDate: opts.includeAbsence ? localDateOf(new Date()) : undefined,
      });
      return opts.includeAbsence ? rows : rows.map(({ absentToday: _absent, ...row }) => row);
    },

    // Stämpla in: clock an employee in on an MO operation. Stamping in on a
    // released order means work has begun, so the MO auto-starts. An employee
    // can have several open stamp sessions at once (e.g. selecting multiple
    // operations at the terminal and starting them together) — the only
    // thing refused is stamping in twice on the *same* operation while a
    // session on it is already open.
    async stampIn(input: StampInInput, createdBy: string) {
      const employee = await repo.findEmployeeById(input.employeeId);
      if (!employee) throw new EmployeeNotFoundError(input.employeeId);
      if (!employee.active) throw new InactiveEmployeeError();

      const operation = await manufacturing.getOperation(input.moOperationId);
      if (!operation) throw new MOOperationNotFoundError(input.moOperationId);
      if (operation.status === "done") {
        throw new InvalidStatusTransitionError("Cannot stamp in on an operation that is already done");
      }

      const order = await manufacturing.getManufacturingOrder(operation.manufacturingOrderId);
      if (!order || (order.status !== "released" && order.status !== "in_progress")) {
        throw new InvalidStatusTransitionError(
          "Stamping is only possible while the order is released or in progress"
        );
      }

      if (await repo.hasOpenStampSessionForOperation(input.employeeId, input.moOperationId)) {
        throw new AlreadyStampedInError();
      }

      // Regel 5: stamping in on work means the employee is here — without
      // an open attendance the stamp clocks them in too (and resumes work
      // paused by the previous Gå hem, exactly like Kom). That can need a
      // sen ankomst reason, asked before anything (the order's start) is
      // written.
      const startsAttendance = !(await repo.hasOpenAttendanceSession(input.employeeId));
      const at = clock();
      if (input.attendanceReason) await assertActiveReason(input.attendanceReason.reasonId);
      if (startsAttendance) await assertArrivalReason(input.employeeId, at, input.attendanceReason);

      if (order.status === "released") {
        await manufacturing.start(order.id);
      }

      let attendanceStarted = false;
      if (startsAttendance) {
        await beginAttendance(input.employeeId, createdBy, at, input.attendanceReason);
        attendanceStarted = true;
      }
      const session = await repo.createStampSession(input.employeeId, input.moOperationId, createdBy);
      return { ...session, attendanceStarted };
    },

    // Stämpla ut: close the session, materialize a time report from the
    // elapsed time, and optionally mark the operation done with its total
    // reported time as actual time (efterkalkyl input).
    async stampOut(sessionId: string, input: StampOutInput, createdBy: string) {
      return doStampOut(sessionId, input, createdBy);
    },

    // GDPR (#2): what Radera/Anonymisera would do for the employee now, and
    // what blocks it. Null when the employee does not exist.
    async getEmployeeErasure(id: string) {
      const employee = await repo.findEmployeeById(id);
      if (!employee) return null;
      return erasurePlan(employee, await repo.readErasureFacts(id));
    },

    async deleteEmployee(id: string, userId: string) {
      return erase(id, "delete", userId);
    },

    async anonymizeEmployee(id: string, userId: string) {
      return erase(id, "anonymize", userId);
    },

    async updateEmployee(id: string, input: UpdateEmployeeInput) {
      const current = await repo.findEmployeeById(id);
      if (current?.anonymizedAt) throw new EmployeeAnonymizedError(id);
      if (input.defaultWeekScheduleId != null && !(await repo.weekScheduleExists(input.defaultWeekScheduleId))) {
        throw new WeekScheduleNotFoundError(input.defaultWeekScheduleId);
      }
      if (input.defaultWorkCenterIds !== undefined) {
        const [missing] = await repo.missingWorkCenterIds(input.defaultWorkCenterIds);
        if (missing !== undefined) throw new WorkCenterNotFoundError(missing);
      }
      let row;
      try {
        row = await repo.updateEmployee(id, input);
      } catch (err) {
        if (isUniqueViolation(err)) throw new DuplicateEmployeeNumberError(input.employeeNumber ?? "");
        // A work center deleted between the check above and the insert.
        if (isForeignKeyViolation(err, "employee_work_centers_work_center_id_work_centers_id_fk")) {
          const [gone] = await repo.missingWorkCenterIds(input.defaultWorkCenterIds ?? []);
          throw new WorkCenterNotFoundError(gone ?? "");
        }
        throw err;
      }
      if (!row) throw new EmployeeNotFoundError(id);
      const defaults = await repo.workCenterIdsByEmployee([id]);
      return { ...row, defaultWorkCenterIds: defaults.get(id) ?? [] };
    },

    async listAttendanceSessions(onlyOpen: boolean) {
      return repo.listAttendanceSessions(onlyOpen);
    },

    // Närvarostämpling kom: attendance is independent of work stamps and
    // never parallel — one open attendance per employee, always.
    async attendanceIn(input: AttendanceInInput, createdBy: string) {
      const employee = await repo.findEmployeeById(input.employeeId);
      if (!employee) throw new EmployeeNotFoundError(input.employeeId);
      if (!employee.active) throw new InactiveEmployeeError();
      if (input.reason) await assertActiveReason(input.reason.reasonId);
      const open = await repo.findOpenAttendanceSession(input.employeeId);
      // Resume any work paused by the previous going-home — the pause folds
      // into pausedSeconds and is excluded from reported hours.
      const now = clock();
      if (!open) {
        await assertArrivalReason(input.employeeId, now, input.reason);
        return beginAttendance(input.employeeId, createdBy, now, input.reason);
      }

      // Stockholm days (localDateOf) — the container's own zone may be UTC.
      const today = localDateOf(now);
      if (localDateOf(open.startedAt) >= today) throw new AlreadyPresentError();
      if (!input.forgottenStoppedAt) throw new AttendanceOpenFromEarlierDayError(open.id, open.startedAt);

      // Regel 8: the forgotten Gå hem, then today's attendance.
      const stop = new Date(input.forgottenStoppedAt);
      if (stop <= open.startedAt || localDateOf(stop) >= today) throw new InvalidAttendanceIntervalError();
      for (const date of new Set([localDateOf(open.startedAt), localDateOf(stop)])) {
        if (await periodLocks.isDateLocked(date)) throw new PayrollPeriodLockedError(date);
      }
      // The forgotten stop time is an estimate and asks for no reason;
      // today's new attendance is judged like any other.
      await assertArrivalReason(input.employeeId, now, input.reason, { id: open.id, startedAt: open.startedAt, stop });
      const session = await repo.closeForgottenAndBegin(
        input.employeeId,
        open.id,
        stop,
        now,
        createdBy,
        toStampReason(input.reason)
      );
      // Someone else closed it in between (double tap, retry) — they also
      // opened today's attendance.
      if (!session) throw new AlreadyPresentError();
      await audit.log({
        entityType: "attendance_session",
        entityId: open.id,
        action: "updated",
        detail: { employeeId: input.employeeId, before: { stoppedAt: null }, after: { stoppedAt: stop }, forgotten: true },
        userId: createdBy,
      });
      return session;
    },

    // Närvarostämpling gå: going home PAUSES any open work stamps — the
    // employee stays stamped in, but the away time is excluded from reported
    // hours and the work resumes at the next attendance-in.
    //
    // Närvaroavvikelser: before anything is written the stop is judged at
    // `at` — tidig hemgång (unless Ta ut ATF explains it) and, when the day
    // gets overtime by payroll's own rule, how it is compensated. A missing
    // answer is a 409 the terminal turns into its questions; the answers are
    // stored in the same transaction that closes the attendance.
    async attendanceOut(sessionId: string, createdBy: string, input: AttendanceOutInput = {}) {
      const session = await repo.findAttendanceSessionById(sessionId);
      if (!session) throw new AttendanceSessionNotFoundError(sessionId);
      if (session.stoppedAt) throw new AttendanceSessionAlreadyStoppedError();

      // One instant for the judgement, the stop and the paused work, so a
      // later correction of the stop time (regel 7) finds the pause exactly
      // where the attendance stopped.
      const at = clock();
      const date = localDateOf(at);

      if (input.reason) await assertActiveReason(input.reason.reasonId);
      if (input.atfTransactionId) {
        // Kept for older terminals: the id Ta ut ATF sends must be today's
        // withdrawal by this employee. The exemption itself no longer needs
        // it — any withdrawal that day explains leaving early (below).
        const atf = await repo.findAtfTransactionById(input.atfTransactionId);
        if (!atf || atf.employeeId !== session.employeeId || atf.type !== "withdrawal" || atf.date !== date) {
          throw new AtfTransactionMismatchError(input.atfTransactionId);
        }
      }

      let disposition: OvertimeDisposition | null = null;
      if (deviations && !(await periodLocks.isDateLocked(date))) {
        const settings = await deviationCheck("settings", session.employeeId, null, () => deviations.settings.getSettings());
        let reasonQuestion: { kind: "late" | "early"; minutes: number; scheduledTime: string } | null = null;
        let overtimeQuestion: OvertimeQuestion | null = null;

        // An attendance open since an earlier day is a forgotten Gå hem (or a
        // night shift past midnight): its stop time is not a departure from
        // today's schedule and its "overtime" is the night, which the
        // supervisor corrects — asking about either would only store a
        // meaningless answer.
        const sameDay = localDateOf(session.startedAt) === date;

        if (settings?.attendanceReasonRequired && !input.reason && sameDay) {
          const early = await deviationCheck("tidig hemgång", session.employeeId, null, async () =>
            assessDeparture({
              date,
              schedule: await scheduleOn(session.employeeId, date),
              startedAt: session.startedAt,
              at,
              // Ta ut ATF: the same rule as the attestation's Avvikelser.
              atfWithdrawal:
                input.atfTransactionId !== undefined || (await repo.hasAtfWithdrawalOnDay(session.employeeId, date)),
              settings,
            })
          );
          if (early?.requiresReason) {
            reasonQuestion = { kind: early.kind, minutes: early.minutes, scheduledTime: early.scheduledTime };
          }
        }

        if (settings?.terminalOvertimeChoice && !input.overtimeDisposition && sameDay) {
          overtimeQuestion = await deviationCheck("övertid", session.employeeId, null, async () => {
            const day = await deviations.previewDay(session.employeeId, date, { closeOpenAt: at });
            const minutes = day.overtimeMinutes + day.overtimeOffScheduleMinutes;
            return minutes > 0
              ? { minutes, offSchedule: day.overtimeOffScheduleMinutes > 0, current: day.overtimeDisposition }
              : null;
          });
        }

        if (reasonQuestion || overtimeQuestion) throw new AttendanceInputRequiredError(reasonQuestion, overtimeQuestion);
        // A choice sent is stored (the last Gå hem of the day wins); in a
        // locked period nothing is asked and nothing written.
        disposition = input.overtimeDisposition ?? null;
      }

      let dispositionId: string | null = null;
      const stopped = await repo.stopAttendance(sessionId, session.employeeId, at, toStampReason(input.reason), async (tx) => {
        if (disposition) {
          const row = await deviations!.dispositionWriter.upsert(tx, session.employeeId, date, disposition, createdBy);
          dispositionId = row.id;
        }
      });
      if (!stopped) throw new AttendanceSessionAlreadyStoppedError();

      // Plain Gå hem was never logged (the session is the record); the log
      // gets the answers the terminal collected.
      if (input.reason || disposition || input.atfTransactionId) {
        await audit.log({
          entityType: "attendance_session",
          entityId: sessionId,
          action: "attendance_stopped",
          detail: {
            employeeId: session.employeeId,
            stoppedAt: at,
            stopReasonId: input.reason?.reasonId ?? null,
            stopNote: input.reason?.note || null,
            overtimeDisposition: disposition,
            atfTransactionId: input.atfTransactionId ?? null,
          },
          userId: createdBy,
        });
      }
      if (disposition && dispositionId) {
        await audit.log({
          entityType: "overtime_disposition",
          entityId: dispositionId,
          action: "set",
          detail: { employeeId: session.employeeId, date, disposition, source: "terminal" },
          userId: createdBy,
        });
      }
      return stopped;
    },

    // Supervisor correction: merges the given fields onto the existing
    // session. `stoppedAt: null` re-opens a previously stopped session (e.g.
    // it was closed too early) — that can never collide with another open
    // session for the same employee, since attendance is never parallel.
    // Both the old and new local dates are guarded against a locked payroll
    // period, since either side of the edit could move hours into/out of a
    // frozen basis.
    async updateAttendanceSession(id: string, input: UpdateAttendanceSessionInput, userId: string) {
      const existing = await repo.findAttendanceSessionById(id);
      if (!existing) throw new AttendanceSessionNotFoundError(id);

      const newStartedAt = input.startedAt !== undefined ? new Date(input.startedAt) : existing.startedAt;
      const reopening = input.stoppedAt === null && existing.stoppedAt !== null;
      const newStoppedAt =
        input.stoppedAt === undefined ? existing.stoppedAt : input.stoppedAt === null ? null : new Date(input.stoppedAt);

      if (newStoppedAt !== null && newStoppedAt <= newStartedAt) {
        throw new InvalidAttendanceIntervalError();
      }
      // A stop time can't lie in the future (one minute of slack for clock
      // skew, as regel 6): it would pause work that is still going on.
      if (newStoppedAt !== null && newStoppedAt.getTime() > Date.now() + 60_000) {
        throw new InvalidAttendanceIntervalError();
      }

      if (reopening && (await repo.hasOpenAttendanceSession(existing.employeeId))) {
        throw new AlreadyPresentError();
      }

      const datesToCheck = new Set<string>([localDateOf(existing.startedAt), localDateOf(newStartedAt)]);
      if (existing.stoppedAt) datesToCheck.add(localDateOf(existing.stoppedAt));
      if (newStoppedAt) datesToCheck.add(localDateOf(newStoppedAt));
      for (const date of datesToCheck) {
        if (await periodLocks.isDateLocked(date)) throw new PayrollPeriodLockedError(date);
      }

      // The stamps' reasons: null clears, undefined keeps. A new reason must
      // be active; the one already on the session may have been inactivated
      // since and is kept as it is.
      const reasons = {
        startReasonId: input.startReasonId === undefined ? existing.startReasonId : input.startReasonId,
        startNote: input.startNote === undefined ? existing.startNote : input.startNote || null,
        stopReasonId: input.stopReasonId === undefined ? existing.stopReasonId : input.stopReasonId,
        stopNote: input.stopNote === undefined ? existing.stopNote : input.stopNote || null,
      };
      if (reasons.startReasonId && reasons.startReasonId !== existing.startReasonId) {
        await assertActiveReason(reasons.startReasonId);
      }
      if (reasons.stopReasonId && reasons.stopReasonId !== existing.stopReasonId) {
        await assertActiveReason(reasons.stopReasonId);
      }

      // Regel 7: the correction carries over to the employee's work stamps.
      const effect =
        existing.stoppedAt === null && newStoppedAt !== null
          ? { kind: "pause" as const, employeeId: existing.employeeId, at: newStoppedAt }
          : existing.stoppedAt !== null && newStoppedAt !== null && newStoppedAt.getTime() !== existing.stoppedAt.getTime()
            ? { kind: "move" as const, employeeId: existing.employeeId, from: existing.stoppedAt, to: newStoppedAt }
            : null;
      // Only what the supervisor changed is written, and only while the stop
      // time is still the one read above (a Gå hem in between ⇒ 409).
      const patch = {
        ...(input.startedAt !== undefined ? { startedAt: newStartedAt } : {}),
        ...(input.stoppedAt !== undefined ? { stoppedAt: newStoppedAt } : {}),
        ...(input.startReasonId !== undefined ? { startReasonId: reasons.startReasonId } : {}),
        ...(input.startNote !== undefined ? { startNote: reasons.startNote } : {}),
        ...(input.stopReasonId !== undefined ? { stopReasonId: reasons.stopReasonId } : {}),
        ...(input.stopNote !== undefined ? { stopNote: reasons.stopNote } : {}),
      };
      const { session: updated, pausedWorkSessions, movedPauses } = await repo.correctAttendanceWithWork(
        id,
        patch,
        existing.stoppedAt,
        effect
      );
      if (!updated) throw new AttendanceSessionChangedError(id);

      await audit.log({
        entityType: "attendance_session",
        entityId: id,
        action: "updated",
        detail: {
          employeeId: existing.employeeId,
          before: {
            startedAt: existing.startedAt,
            stoppedAt: existing.stoppedAt,
            startReasonId: existing.startReasonId,
            startNote: existing.startNote,
            stopReasonId: existing.stopReasonId,
            stopNote: existing.stopNote,
          },
          after: { startedAt: newStartedAt, stoppedAt: newStoppedAt, ...reasons },
        },
        userId,
      });
      return { ...updated, pausedWorkSessions, movedPauses };
    },

    // Deleting does NOT touch stamp sessions — work stamps are independent
    // of attendance and pause bookkeeping on them is historical, so nothing
    // needs to be re-linked or re-paused.
    async deleteAttendanceSession(id: string, userId: string) {
      const existing = await repo.findAttendanceSessionById(id);
      if (!existing) throw new AttendanceSessionNotFoundError(id);

      const datesToCheck = new Set<string>([localDateOf(existing.startedAt)]);
      if (existing.stoppedAt) datesToCheck.add(localDateOf(existing.stoppedAt));
      for (const date of datesToCheck) {
        if (await periodLocks.isDateLocked(date)) throw new PayrollPeriodLockedError(date);
      }

      const deleted = await repo.deleteAttendanceSession(id);
      await audit.log({
        entityType: "attendance_session",
        entityId: id,
        action: "deleted",
        detail: { employeeId: existing.employeeId, startedAt: existing.startedAt, stoppedAt: existing.stoppedAt },
        userId,
      });
      return deleted!;
    },

    // Supervisor correction of a manually entered or terminal-materialized
    // time report. Both the old and new date are guarded against a locked
    // payroll period. Editing does NOT retro-adjust
    // mo_operations.quantity_completed/actualTime — efterkalkyl reads
    // time_reports on demand (sumReportedHoursForOperation / the operation's
    // "mark done" total), so there is no cascade to run here.
    async updateTimeReport(id: string, input: UpdateTimeReportInput, userId: string) {
      const existing = await repo.findTimeReportById(id);
      if (!existing) throw new TimeReportNotFoundError(id);

      if (await periodLocks.isDateLocked(existing.date)) throw new PayrollPeriodLockedError(existing.date);

      const newDate = input.date ?? existing.date;
      const newHours = input.hours ?? Number(existing.hours);
      const newNote = input.note === undefined ? existing.note : input.note;

      if (await periodLocks.isDateLocked(newDate)) throw new PayrollPeriodLockedError(newDate);

      const updated = await repo.updateTimeReport(id, { date: newDate, hours: newHours, note: newNote });

      await audit.log({
        entityType: "time_report",
        entityId: id,
        action: "updated",
        detail: {
          employeeId: existing.employeeId,
          before: { date: existing.date, hours: existing.hours, note: existing.note },
          after: { date: newDate, hours: newHours, note: newNote },
        },
        userId,
      });
      return updated!;
    },

    // Deleting unlinks any stamp session automatically
    // (stamp_sessions.time_report_id is ON DELETE SET NULL) — the work stamp
    // row itself, and its pause bookkeeping, is untouched.
    async deleteTimeReport(id: string, userId: string) {
      const existing = await repo.findTimeReportById(id);
      if (!existing) throw new TimeReportNotFoundError(id);

      if (await periodLocks.isDateLocked(existing.date)) throw new PayrollPeriodLockedError(existing.date);

      const deleted = await repo.deleteTimeReport(id);
      await audit.log({
        entityType: "time_report",
        entityId: id,
        action: "deleted",
        detail: {
          employeeId: existing.employeeId,
          moOperationId: existing.moOperationId,
          date: existing.date,
          hours: existing.hours,
        },
        userId,
      });
      return deleted!;
    },
  };
}

export type TimeReportService = ReturnType<typeof createTimeReportService>;
