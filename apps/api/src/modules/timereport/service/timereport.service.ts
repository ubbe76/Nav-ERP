import type {
  AttendanceInInput,
  CreateEmployeeInput,
  CreateTimeReportInput,
  ListQuery,
  StampInInput,
  StampOutInput,
  UpdateAttendanceSessionInput,
  UpdateEmployeeInput,
  UpdateTimeReportInput,
} from "@navet/shared";
import type { TimeReportRepository } from "../repository/timereport.repository.js";
import type { ManufacturingService } from "../../manufacturing/service/manufacturing.service.js";
import {
  InvalidStatusTransitionError,
  MOOperationNotFoundError,
} from "../../manufacturing/service/manufacturing.service.js";
// Leaf file in the payroll module — no import cycle (see period-lock.ts).
import { PayrollPeriodLockedError, type PeriodLockChecker } from "../../payroll/service/period-lock.js";
import type { AuditWriter } from "../../system/repository/audit.repository.js";
import { isUniqueViolation } from "../../system/service/db-errors.js";

export class EmployeeNotFoundError extends Error {
  constructor(id: string) {
    super(`Employee ${id} not found`);
    this.name = "EmployeeNotFoundError";
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

export class InvalidAttendanceIntervalError extends Error {
  constructor() {
    super("Stopped time must be after started time");
    this.name = "InvalidAttendanceIntervalError";
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

// Today in the server's local timezone as YYYY-MM-DD (sv-SE formats ISO-style)
// — a stamp-out just before midnight should land on the day the work was done.
function localToday() {
  return new Date().toLocaleDateString("sv-SE");
}

// Same local-date idiom, for an arbitrary instant — used to resolve which
// payroll period a session's started_at/stopped_at falls into.
function localDateOf(date: Date) {
  return date.toLocaleDateString("sv-SE");
}

export function createTimeReportService(
  repo: TimeReportRepository,
  manufacturing: ManufacturingService,
  periodLocks: PeriodLockChecker,
  audit: AuditWriter
) {
  // Stämpla ut: closes the session, materializes the time report and
  // reports the stint's quantities on the operation. (Going home no longer
  // comes through here — attendanceOut pauses open work stamps instead.)
  async function doStampOut(sessionId: string, input: StampOutInput, createdBy: string) {
    const session = await repo.findStampSessionById(sessionId);
    if (!session) throw new StampSessionNotFoundError(sessionId);
    if (session.stoppedAt) throw new StampSessionAlreadyStoppedError();

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
        { quantityOk, quantityScrapped, scrapReason: input.scrapReason, markDone, employeeId: session.employeeId, createdBy },
        input.allowMaterialShortage
      );
    }

    const stoppedAt = new Date();
    // Paused time (away from work, e.g. gone home overnight) is excluded
    // from the reported hours; an ongoing pause counts up to stoppedAt.
    const ongoingPauseMs = session.pausedAt ? stoppedAt.getTime() - session.pausedAt.getTime() : 0;
    const pausedMs = Number(session.pausedSeconds) * 1000 + Math.max(ongoingPauseMs, 0);
    const elapsedHours = (stoppedAt.getTime() - session.startedAt.getTime() - pausedMs) / 3_600_000;
    const hours = Math.max(0.01, Math.round(elapsedHours * 100) / 100);

    const report = await repo.createTimeReport(
      {
        employeeId: session.employeeId,
        moOperationId: session.moOperationId,
        date: localToday(),
        hours,
        note: input.note,
      },
      createdBy
    );
    const closed = await repo.closeStampSession(sessionId, stoppedAt, report.id);

    if (hasQuantities || markDone) {
      const totalHours = markDone ? await repo.sumReportedHoursForOperation(session.moOperationId) : undefined;
      await manufacturing.reportOperationQuantities(session.moOperationId, {
        quantityOk,
        quantityScrapped,
        scrapReason: input.scrapReason,
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
    } else {
      // Nothing to report, but the stamp is still a report row on the TO
      // card, so its time can be undone there too.
      await manufacturing.logTimeOnlyReport(session.moOperationId, {
        timeReportId: report.id,
        employeeId: session.employeeId,
        createdBy,
      });
    }

    return { session: closed!, timeReport: report };
  }

  return {
    async createEmployee(input: CreateEmployeeInput) {
      return repo.createEmployee(input);
    },

    async getEmployee(id: string) {
      return repo.findEmployeeById(id);
    },

    async listEmployees() {
      return repo.listEmployees();
    },

    // Personalkatalog — names and numbers only, for the shop floor.
    async listEmployeeDirectory() {
      const rows = await repo.listEmployeeDirectory();
      return rows.sort((a, b) => a.employeeNumber.localeCompare(b.employeeNumber, "sv", { numeric: true }));
    },

    // Manually entered time report. Stamp-outs go through doStampOut instead
    // and always land on today's date, which can never sit inside a locked
    // period (a period is only lockable once its last day has passed).
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

    async listStampSessions(onlyOpen: boolean) {
      return repo.listStampSessions(onlyOpen);
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

      if (order.status === "released") {
        await manufacturing.start(order.id);
      }

      return repo.createStampSession(input.employeeId, input.moOperationId, createdBy);
    },

    // Stämpla ut: close the session, materialize a time report from the
    // elapsed time, and optionally mark the operation done with its total
    // reported time as actual time (efterkalkyl input).
    async stampOut(sessionId: string, input: StampOutInput, createdBy: string) {
      return doStampOut(sessionId, input, createdBy);
    },

    async updateEmployee(id: string, input: UpdateEmployeeInput) {
      if (input.defaultWeekScheduleId != null && !(await repo.weekScheduleExists(input.defaultWeekScheduleId))) {
        throw new WeekScheduleNotFoundError(input.defaultWeekScheduleId);
      }
      try {
        const row = await repo.updateEmployee(id, input);
        if (!row) throw new EmployeeNotFoundError(id);
        return row;
      } catch (err) {
        if (isUniqueViolation(err)) throw new DuplicateEmployeeNumberError(input.employeeNumber ?? "");
        throw err;
      }
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
      if (await repo.hasOpenAttendanceSession(input.employeeId)) throw new AlreadyPresentError();
      // Resume any work paused by the previous going-home — the pause folds
      // into pausedSeconds and is excluded from reported hours.
      await repo.resumeStampSessions(input.employeeId, new Date());
      return repo.createAttendanceSession(input.employeeId, createdBy);
    },

    // Närvarostämpling gå: going home PAUSES any open work stamps — the
    // employee stays stamped in, but the away time is excluded from reported
    // hours and the work resumes at the next attendance-in.
    async attendanceOut(sessionId: string, createdBy: string) {
      const session = await repo.findAttendanceSessionById(sessionId);
      if (!session) throw new AttendanceSessionNotFoundError(sessionId);
      if (session.stoppedAt) throw new AttendanceSessionAlreadyStoppedError();

      // Open work stays stamped in but pauses — the away time is excluded
      // from reported hours, and the work resumes at the next attendance-in.
      const pausedWorkSessions = await repo.pauseOpenStampSessions(session.employeeId, new Date());

      const closed = await repo.closeAttendanceSession(sessionId, new Date());
      return { session: closed!, pausedWorkSessions };
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

      if (reopening && (await repo.hasOpenAttendanceSession(existing.employeeId))) {
        throw new AlreadyPresentError();
      }

      const datesToCheck = new Set<string>([localDateOf(existing.startedAt), localDateOf(newStartedAt)]);
      if (existing.stoppedAt) datesToCheck.add(localDateOf(existing.stoppedAt));
      if (newStoppedAt) datesToCheck.add(localDateOf(newStoppedAt));
      for (const date of datesToCheck) {
        if (await periodLocks.isDateLocked(date)) throw new PayrollPeriodLockedError(date);
      }

      const updated = await repo.updateAttendanceSession(id, { startedAt: newStartedAt, stoppedAt: newStoppedAt });

      await audit.log({
        entityType: "attendance_session",
        entityId: id,
        action: "updated",
        detail: {
          employeeId: existing.employeeId,
          before: { startedAt: existing.startedAt, stoppedAt: existing.stoppedAt },
          after: { startedAt: newStartedAt, stoppedAt: newStoppedAt },
        },
        userId,
      });
      return updated!;
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
