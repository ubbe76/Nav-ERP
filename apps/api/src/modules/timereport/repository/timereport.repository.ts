import { and, count, desc, eq, gt, ilike, isNotNull, isNull, lt, or, sql, getTableColumns } from "drizzle-orm";
import {
  articles,
  attendanceSessions,
  employees,
  manufacturingOrders,
  moOperations,
  stampSessions,
  timeReports,
  weekSchedules,
  workCenters,
  type Db,
} from "@navet/db";
import {
  ilikePattern,
  type CreateEmployeeInput,
  type CreateTimeReportInput,
  type ListQuery,
  type UpdateEmployeeInput,
} from "@navet/shared";

// Columns shared by every time-report listing; `source` marks whether the row
// was materialized by a terminal stamp-out (a stamp_sessions row points at it)
// or entered manually.
const timeReportListColumns = {
  ...getTableColumns(timeReports),
  employeeName: employees.name,
  manufacturingOrderId: moOperations.manufacturingOrderId,
  manufacturingOrderNumber: manufacturingOrders.orderNumber,
  operationSequenceNo: moOperations.sequenceNo,
  workCenterName: workCenters.name,
  source: sql<"terminal" | "manual">`case when ${stampSessions.id} is null then 'manual' else 'terminal' end`,
};

export function createTimeReportRepository(db: Db) {
  return {
    async createEmployee(input: CreateEmployeeInput) {
      const [row] = await db.insert(employees).values(input).returning();
      return row!;
    },

    async findEmployeeById(id: string) {
      const [row] = await db.select().from(employees).where(eq(employees.id, id));
      return row ?? null;
    },

    async listEmployees() {
      return db.select().from(employees);
    },

    // Never widen this projection: it is what /employees/directory hands to
    // users without access to the personnel register (no personnummer, wage,
    // address, phone or email).
    async listEmployeeDirectory() {
      return db
        .select({ id: employees.id, employeeNumber: employees.employeeNumber, name: employees.name, active: employees.active })
        .from(employees);
    },

    // Existence check for defaultWeekScheduleId validation on employee PATCH.
    async weekScheduleExists(id: string) {
      const [row] = await db.select({ id: weekSchedules.id }).from(weekSchedules).where(eq(weekSchedules.id, id)).limit(1);
      return row !== undefined;
    },

    async createTimeReport(input: CreateTimeReportInput, createdBy: string) {
      const [row] = await db
        .insert(timeReports)
        .values({
          employeeId: input.employeeId,
          moOperationId: input.moOperationId,
          date: input.date,
          hours: String(input.hours),
          note: input.note,
          createdBy,
        })
        .returning();
      return row!;
    },

    async listTimeReports(query: ListQuery) {
      const pattern = query.search ? ilikePattern(query.search) : null;
      const where = pattern
        ? or(ilike(employees.name, pattern), ilike(manufacturingOrders.orderNumber, pattern))
        : undefined;

      const [rows, totalRows] = await Promise.all([
        db
          .select(timeReportListColumns)
          .from(timeReports)
          .innerJoin(employees, eq(employees.id, timeReports.employeeId))
          .innerJoin(moOperations, eq(moOperations.id, timeReports.moOperationId))
          .innerJoin(manufacturingOrders, eq(manufacturingOrders.id, moOperations.manufacturingOrderId))
          .innerJoin(workCenters, eq(workCenters.id, moOperations.workCenterId))
          .leftJoin(stampSessions, eq(stampSessions.timeReportId, timeReports.id))
          .where(where)
          .orderBy(desc(timeReports.date), desc(timeReports.createdAt))
          .limit(query.limit)
          .offset(query.offset),
        db
          .select({ total: count() })
          .from(timeReports)
          .innerJoin(employees, eq(employees.id, timeReports.employeeId))
          .innerJoin(moOperations, eq(moOperations.id, timeReports.moOperationId))
          .innerJoin(manufacturingOrders, eq(manufacturingOrders.id, moOperations.manufacturingOrderId))
          .where(where),
      ]);
      return { rows, total: totalRows[0]!.total };
    },

    async listTimeReportsByManufacturingOrder(manufacturingOrderId: string) {
      return db
        .select(timeReportListColumns)
        .from(timeReports)
        .innerJoin(employees, eq(employees.id, timeReports.employeeId))
        .innerJoin(moOperations, eq(moOperations.id, timeReports.moOperationId))
        .innerJoin(manufacturingOrders, eq(manufacturingOrders.id, moOperations.manufacturingOrderId))
        .innerJoin(workCenters, eq(workCenters.id, moOperations.workCenterId))
        .leftJoin(stampSessions, eq(stampSessions.timeReportId, timeReports.id))
        .where(eq(moOperations.manufacturingOrderId, manufacturingOrderId));
    },

    async createStampSession(employeeId: string, moOperationId: string, createdBy: string) {
      const [row] = await db.insert(stampSessions).values({ employeeId, moOperationId, createdBy }).returning();
      return row!;
    },

    async findStampSessionById(id: string) {
      const [row] = await db.select().from(stampSessions).where(eq(stampSessions.id, id));
      return row ?? null;
    },

    // Scoped to a single operation: an employee may have several open
    // sessions at once (different operations), but never two open sessions
    // on the same operation.
    async hasOpenStampSessionForOperation(employeeId: string, moOperationId: string) {
      const [row] = await db
        .select({ id: stampSessions.id })
        .from(stampSessions)
        .where(
          and(
            eq(stampSessions.employeeId, employeeId),
            eq(stampSessions.moOperationId, moOperationId),
            isNull(stampSessions.stoppedAt)
          )
        )
        .limit(1);
      return row !== undefined;
    },

    // Joined view for the terminal: who is stamped in, on which operation of
    // which order/article, since when.
    async listStampSessions(onlyOpen: boolean) {
      return db
        .select({
          ...getTableColumns(stampSessions),
          employeeName: employees.name,
          employeeNumber: employees.employeeNumber,
          manufacturingOrderId: moOperations.manufacturingOrderId,
          manufacturingOrderNumber: manufacturingOrders.orderNumber,
          operationSequenceNo: moOperations.sequenceNo,
          workCenterName: workCenters.name,
          articleName: articles.name,
          // Shop-floor packing instructions for the current operation —
          // shown in the terminal's stamp-out view when set.
          packingInstructions: moOperations.packingInstructions,
          // Planned vs. already reported on the operation, so the stamp-out
          // view can show what remains to manufacture (planned − OK).
          orderQuantity: manufacturingOrders.quantity,
          operationQuantityCompleted: moOperations.quantityCompleted,
          operationQuantityScrapped: moOperations.quantityScrapped,
        })
        .from(stampSessions)
        .innerJoin(employees, eq(employees.id, stampSessions.employeeId))
        .innerJoin(moOperations, eq(moOperations.id, stampSessions.moOperationId))
        .innerJoin(manufacturingOrders, eq(manufacturingOrders.id, moOperations.manufacturingOrderId))
        .innerJoin(workCenters, eq(workCenters.id, moOperations.workCenterId))
        .innerJoin(articles, eq(articles.id, manufacturingOrders.articleId))
        .where(onlyOpen ? isNull(stampSessions.stoppedAt) : undefined)
        .orderBy(desc(stampSessions.startedAt));
    },

    async closeStampSession(id: string, stoppedAt: Date, timeReportId: string) {
      const [row] = await db
        .update(stampSessions)
        .set({ stoppedAt, timeReportId })
        .where(eq(stampSessions.id, id))
        .returning();
      return row ?? null;
    },

    async sumReportedHoursForOperation(moOperationId: string) {
      const [row] = await db
        .select({ total: sql<string>`coalesce(sum(${timeReports.hours}), 0)` })
        .from(timeReports)
        .where(eq(timeReports.moOperationId, moOperationId));
      return Number(row?.total ?? 0);
    },

    async findTimeReportById(id: string) {
      const [row] = await db.select().from(timeReports).where(eq(timeReports.id, id));
      return row ?? null;
    },

    // Called with the already-merged final values — the service computes
    // date/hours/note before calling in, so this is a plain overwrite.
    async updateTimeReport(id: string, patch: { date: string; hours: number; note: string | null }) {
      const [row] = await db
        .update(timeReports)
        .set({ date: patch.date, hours: String(patch.hours), note: patch.note })
        .where(eq(timeReports.id, id))
        .returning();
      return row ?? null;
    },

    // stamp_sessions.time_report_id is ON DELETE SET NULL, so deleting a
    // report that came from the terminal just unlinks the stamp session.
    async deleteTimeReport(id: string) {
      const [row] = await db.delete(timeReports).where(eq(timeReports.id, id)).returning();
      return row ?? null;
    },

    async updateEmployee(id: string, input: UpdateEmployeeInput) {
      const [row] = await db
        .update(employees)
        .set({
          ...input,
          wage: input.wage === undefined ? undefined : input.wage === null ? null : String(input.wage),
          weeklyHours:
            input.weeklyHours === undefined ? undefined : input.weeklyHours === null ? null : String(input.weeklyHours),
        })
        .where(eq(employees.id, id))
        .returning();
      return row ?? null;
    },

    async createAttendanceSession(employeeId: string, createdBy: string) {
      const [row] = await db.insert(attendanceSessions).values({ employeeId, createdBy }).returning();
      return row!;
    },

    async findAttendanceSessionById(id: string) {
      const [row] = await db.select().from(attendanceSessions).where(eq(attendanceSessions.id, id));
      return row ?? null;
    },

    async hasOpenAttendanceSession(employeeId: string) {
      const [row] = await db
        .select({ id: attendanceSessions.id })
        .from(attendanceSessions)
        .where(and(eq(attendanceSessions.employeeId, employeeId), isNull(attendanceSessions.stoppedAt)))
        .limit(1);
      return row !== undefined;
    },

    async listAttendanceSessions(onlyOpen: boolean) {
      return db
        .select({
          ...getTableColumns(attendanceSessions),
          employeeName: employees.name,
          employeeNumber: employees.employeeNumber,
        })
        .from(attendanceSessions)
        .innerJoin(employees, eq(employees.id, attendanceSessions.employeeId))
        .where(onlyOpen ? isNull(attendanceSessions.stoppedAt) : undefined)
        .orderBy(desc(attendanceSessions.startedAt));
    },

    // Sessions overlapping [from, to), including still-open ones (a null
    // stoppedAt is treated as "unbounded future" via the coalesce-to-infinity
    // trick) — the payroll summary passes this the whole period's bounds and
    // groups the result per employee/date itself.
    async listAttendanceSessionsInRange(from: Date, to: Date) {
      return db
        .select({
          id: attendanceSessions.id,
          employeeId: attendanceSessions.employeeId,
          startedAt: attendanceSessions.startedAt,
          stoppedAt: attendanceSessions.stoppedAt,
        })
        .from(attendanceSessions)
        .where(
          and(
            lt(attendanceSessions.startedAt, to),
            or(isNull(attendanceSessions.stoppedAt), gt(attendanceSessions.stoppedAt, from))
          )
        )
        .orderBy(attendanceSessions.startedAt);
    },

    async closeAttendanceSession(id: string, stoppedAt: Date) {
      const [row] = await db
        .update(attendanceSessions)
        .set({ stoppedAt })
        .where(eq(attendanceSessions.id, id))
        .returning();
      return row ?? null;
    },

    // Called with the already-merged final values (see updateTimeReport).
    async updateAttendanceSession(id: string, patch: { startedAt: Date; stoppedAt: Date | null }) {
      const [row] = await db
        .update(attendanceSessions)
        .set({ startedAt: patch.startedAt, stoppedAt: patch.stoppedAt })
        .where(eq(attendanceSessions.id, id))
        .returning();
      return row ?? null;
    },

    // Does not touch stamp_sessions — work stamps are independent of
    // attendance, and pause bookkeeping on them stays historical.
    async deleteAttendanceSession(id: string) {
      const [row] = await db.delete(attendanceSessions).where(eq(attendanceSessions.id, id)).returning();
      return row ?? null;
    },

    async listOpenStampSessionIdsByEmployee(employeeId: string) {
      const rows = await db
        .select({ id: stampSessions.id })
        .from(stampSessions)
        .where(and(eq(stampSessions.employeeId, employeeId), isNull(stampSessions.stoppedAt)));
      return rows.map((r) => r.id);
    },

    // Going home: open work stays stamped in but pauses — the away time is
    // excluded from reported hours. Already-paused sessions are left as-is.
    async pauseOpenStampSessions(employeeId: string, at: Date) {
      const rows = await db
        .update(stampSessions)
        .set({ pausedAt: at })
        .where(
          and(
            eq(stampSessions.employeeId, employeeId),
            isNull(stampSessions.stoppedAt),
            isNull(stampSessions.pausedAt)
          )
        )
        .returning({ id: stampSessions.id });
      return rows.length;
    },

    // Attendance-in resumes paused work: the pause folds into pausedSeconds.
    async resumeStampSessions(employeeId: string, at: Date) {
      const rows = await db
        .update(stampSessions)
        .set({
          pausedSeconds: sql`${stampSessions.pausedSeconds} + extract(epoch from (${at.toISOString()}::timestamptz - ${stampSessions.pausedAt}))`,
          pausedAt: null,
        })
        .where(
          and(
            eq(stampSessions.employeeId, employeeId),
            isNull(stampSessions.stoppedAt),
            isNotNull(stampSessions.pausedAt)
          )
        )
        .returning({ id: stampSessions.id });
      return rows.length;
    },
  };
}

export type TimeReportRepository = ReturnType<typeof createTimeReportRepository>;
