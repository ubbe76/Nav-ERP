import { and, asc, count, desc, eq, gt, ilike, inArray, isNotNull, isNull, lt, ne, or, sql, getTableColumns, type SQL } from "drizzle-orm";
import {
  absences,
  articles,
  atfTransactions,
  attendanceDeviationReasons,
  attendanceSessions,
  employeeWorkCenters,
  employees,
  manufacturingOrders,
  moOperations,
  stampSessions,
  timeReports,
  weekSchedules,
  workCenters,
  type Db,
  type Tx,
} from "@navet/db";
import {
  ilikePattern,
  type CreateEmployeeInput,
  type CreateTimeReportInput,
  type ListQuery,
  type TimeKind,
  type UpdateEmployeeInput,
} from "@navet/shared";
import {
  anonymizeEmployeeInTx,
  deleteEmployeeInTx,
  lockEmployee,
  readErasureFacts,
  type ErasureFacts,
} from "./employee-erasure.js";
import { localDateOf } from "./stamp-close.js";
// Leaf in the payroll module (schema + error only) — no cycle.
import { assertPayrollPeriodsOpenInTx } from "../../payroll/repository/payroll-period-guard.js";

// What the stamp-in asks again on the locked rows (createStampSession).
export interface StampTargetState {
  workCenterId: string;
  operationStatus: (typeof moOperations.$inferSelect)["status"];
  orderStatus: (typeof manufacturingOrders.$inferSelect)["status"] | null;
}

// Columns shared by every time-report listing; `source` marks whether the row
// was materialized by a terminal stamp-out (a stamp_sessions row points at it)
// or entered manually.
const timeReportListColumns = {
  ...getTableColumns(timeReports),
  employeeName: employees.name,
  manufacturingOrderId: moOperations.manufacturingOrderId,
  manufacturingOrderNumber: manufacturingOrders.orderNumber,
  operationSequenceNo: moOperations.sequenceNo,
  // The resource the time was worked on (time_reports.work_center_id, #15);
  // a report from before the column shows the operation's (see
  // timeReportResource).
  workCenterName: workCenters.name,
  source: sql<"terminal" | "manual">`case when ${stampSessions.id} is null then 'manual' else 'terminal' end`,
};

// The join to the report's resource: its own, or (null, before 0192) the
// operation's current one — the same coalesce the efterkalkyl prices on.
const timeReportResource = eq(workCenters.id, sql`coalesce(${timeReports.workCenterId}, ${moOperations.workCenterId})`);

// A stamp's Avvikelseorsak as stored (null = none).
export type StampReason = { reasonId: string | null; note: string | null };
const NO_REASON: StampReason = { reasonId: null, note: null };

// The partial unique indexes behind "one open at a time" (migration 0173):
// a concurrent second stamp fails on them instead of opening a duplicate.
export const ONE_OPEN_ATTENDANCE = "attendance_sessions_one_open_per_employee";
export const ONE_OPEN_STAMP = "stamp_sessions_one_open_per_operation";

// "Still the times that were read", to the millisecond (JS dates have ms,
// Postgres µs) — the condition of the attendance writes that validated or
// guarded against an earlier read.
function unchangedTimes(expected: { startedAt: Date; stoppedAt: Date | null }) {
  return and(
    sql`abs(extract(epoch from (${attendanceSessions.startedAt} - ${expected.startedAt.toISOString()}::timestamptz))) < 0.001`,
    expected.stoppedAt === null
      ? isNull(attendanceSessions.stoppedAt)
      : sql`abs(extract(epoch from (${attendanceSessions.stoppedAt} - ${expected.stoppedAt.toISOString()}::timestamptz))) < 0.001`
  );
}

export function createTimeReportRepository(db: Db) {
  // The stamp list's row: the session with what the terminal and Pågående
  // arbete show around it. Shared by the open list and the paged history.
  function stampSessionRows(where: SQL | undefined, absenceDate?: string) {
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
        // Joined query, so the column references render qualified (the
        // single-table drizzle pitfall does not apply here).
        absentToday: absenceDate
          ? sql<boolean>`exists (select 1 from ${absences} where ${absences.employeeId} = ${stampSessions.employeeId} and ${absences.date} = ${absenceDate})`
          : sql<boolean>`false`,
      })
      .from(stampSessions)
      .innerJoin(employees, eq(employees.id, stampSessions.employeeId))
      .innerJoin(moOperations, eq(moOperations.id, stampSessions.moOperationId))
      .innerJoin(manufacturingOrders, eq(manufacturingOrders.id, moOperations.manufacturingOrderId))
      .innerJoin(workCenters, eq(workCenters.id, moOperations.workCenterId))
      .innerJoin(articles, eq(articles.id, manufacturingOrders.articleId))
      .where(where)
      .orderBy(desc(stampSessions.startedAt), desc(stampSessions.id))
      .$dynamic();
  }

  function attendanceSessionRows(where: SQL | undefined) {
    return db
      .select({
        ...getTableColumns(attendanceSessions),
        employeeName: employees.name,
        employeeNumber: employees.employeeNumber,
      })
      .from(attendanceSessions)
      .innerJoin(employees, eq(employees.id, attendanceSessions.employeeId))
      .where(where)
      .orderBy(desc(attendanceSessions.startedAt), desc(attendanceSessions.id))
      .$dynamic();
  }

  // Conditional: only a still-open attendance is closed, so two Gå hem at
  // once (double tap, two terminals) close it once — null tells the caller.
  async function closeAttendanceSession(id: string, stoppedAt: Date, reason: StampReason = NO_REASON, dbc: Db | Tx = db) {
    const [row] = await dbc
      .update(attendanceSessions)
      .set({ stoppedAt, stopReasonId: reason.reasonId, stopNote: reason.note })
      .where(and(eq(attendanceSessions.id, id), isNull(attendanceSessions.stoppedAt)))
      .returning();
    return row ?? null;
  }

  // Going home: open work stays stamped in but pauses — the away time is
  // excluded from reported hours. Already-paused sessions are left as-is.
  async function pauseOpenStampSessions(employeeId: string, at: Date, dbc: Db | Tx = db) {
    const rows = await dbc
      .update(stampSessions)
      .set({ pausedAt: at })
      .where(and(eq(stampSessions.employeeId, employeeId), isNull(stampSessions.stoppedAt), isNull(stampSessions.pausedAt)))
      .returning({ id: stampSessions.id });
    return rows.length;
  }

  // Attendance-in resumes paused work: the pause folds into pausedSeconds.
  async function resumeOpenStampSessions(employeeId: string, at: Date, dbc: Db | Tx = db) {
    const rows = await dbc
      .update(stampSessions)
      .set({
        pausedSeconds: sql`${stampSessions.pausedSeconds} + extract(epoch from (${at.toISOString()}::timestamptz - ${stampSessions.pausedAt}))`,
        pausedAt: null,
      })
      .where(and(eq(stampSessions.employeeId, employeeId), isNull(stampSessions.stoppedAt), isNotNull(stampSessions.pausedAt)))
      .returning({ id: stampSessions.id });
    return rows.length;
  }

  return {
    async createEmployee(input: CreateEmployeeInput) {
      const [row] = await db.insert(employees).values(input).returning();
      return row!;
    },

    // GDPR (#2): what the personnel card's Radera/Anonymisera may do.
    async readErasureFacts(id: string) {
      return readErasureFacts(db, id);
    },

    // The erasure itself, in one transaction: the employee row locked, the
    // facts read again under that lock, and `decide` — the service's rule —
    // choosing the action or throwing when something blocks it. Null when
    // the employee does not exist.
    async eraseEmployee(
      id: string,
      decide: (employee: typeof employees.$inferSelect, facts: ErasureFacts) => "delete" | "anonymize"
    ) {
      return db.transaction(async (tx) => {
        const employee = await lockEmployee(tx, id);
        if (!employee) return null;
        const action = decide(employee, await readErasureFacts(tx, id));
        if (action === "delete") {
          return { action, employee, ...(await deleteEmployeeInTx(tx, id)) };
        }
        return { action, employee, ...(await anonymizeEmployeeInTx(tx, id)) };
      });
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

    // Förvalda stationer per employee, in one query. Without ids it reads
    // every employee's set (the directory); employees without a set are
    // simply absent from the map.
    async workCenterIdsByEmployee(employeeIds?: string[]) {
      const result = new Map<string, string[]>();
      if (employeeIds && employeeIds.length === 0) return result;
      const rows = await db
        .select({ employeeId: employeeWorkCenters.employeeId, workCenterId: employeeWorkCenters.workCenterId })
        .from(employeeWorkCenters)
        .innerJoin(workCenters, eq(workCenters.id, employeeWorkCenters.workCenterId))
        .where(employeeIds ? inArray(employeeWorkCenters.employeeId, employeeIds) : undefined)
        .orderBy(asc(workCenters.code), asc(workCenters.id));
      for (const row of rows) {
        const ids = result.get(row.employeeId);
        if (ids) ids.push(row.workCenterId);
        else result.set(row.employeeId, [row.workCenterId]);
      }
      return result;
    },

    // The ids among `ids` that are not work centers — validation for
    // defaultWorkCenterIds on employee PATCH.
    async missingWorkCenterIds(ids: string[]) {
      if (ids.length === 0) return [];
      const found = await db.select({ id: workCenters.id }).from(workCenters).where(inArray(workCenters.id, ids));
      const existing = new Set(found.map((row) => row.id));
      return ids.filter((id) => !existing.has(id));
    },

    // Existence check for defaultWeekScheduleId validation on employee PATCH.
    async weekScheduleExists(id: string) {
      const [row] = await db.select({ id: weekSchedules.id }).from(weekSchedules).where(eq(weekSchedules.id, id)).limit(1);
      return row !== undefined;
    },

    // The report keeps the resource the time was worked on (#15, 0192):
    // `workCenterId` when the caller knows it (a stamp-out passes the
    // stamp's), otherwise the operation's resource, read FOR KEY SHARE — the
    // FK's own lock mode, so nothing new conflicts — in the INSERT's
    // transaction: a Byt resurs in progress is waited for and its new
    // resource taken, never the old one it is replacing.
    async createTimeReport(input: CreateTimeReportInput, createdBy: string, workCenterId?: string | null) {
      return db.transaction(async (tx) => {
        let resource = workCenterId ?? null;
        if (resource === null) {
          const [op] = await tx
            .select({ workCenterId: moOperations.workCenterId })
            .from(moOperations)
            .where(eq(moOperations.id, input.moOperationId))
            .for("key share");
          // An unknown operation fails on the FK below, as before.
          resource = op?.workCenterId ?? null;
        }
        const [row] = await tx
          .insert(timeReports)
          .values({
            employeeId: input.employeeId,
            moOperationId: input.moOperationId,
            date: input.date,
            hours: String(input.hours),
            // Ställ/produktion; absent = ej uppdelad.
            kind: input.kind ?? null,
            workCenterId: resource,
            note: input.note,
            createdBy,
          })
          .returning();
        return row!;
      });
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
          .innerJoin(workCenters, timeReportResource)
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
        .innerJoin(workCenters, timeReportResource)
        .leftJoin(stampSessions, eq(stampSessions.timeReportId, timeReports.id))
        .where(eq(moOperations.manufacturingOrderId, manufacturingOrderId));
    },

    // `kind` (ställ/produktion, null = ej uppdelad) and the resource follow
    // the stamp to the time report every stop materializes. The resource is
    // the operation's, read FOR KEY SHARE in the INSERT's transaction (the
    // FK's own lock mode): an instämpling that starts during a Byt resurs
    // waits for it and takes the new resource, and a Byt that starts after
    // the read waits for this commit and is then refused (someone is
    // stamped in). `check` runs before the INSERT on the rows this
    // transaction holds — the operation and then its order FOR SHARE
    // (operation → order, as the reports lock) — and throws to refuse:
    // stampIn asks for the terminal's station, an operation not done and an
    // open order. A report that turns the operation done (FOR UPDATE on it)
    // or a Slutför order / Makulera (FOR UPDATE on the order) that commits
    // while this waits is seen here; one that starts after it waits for this
    // insert and finds the stamp (regel 10 closes it, Makulera refuses an
    // order with an open stamp).
    async createStampSession(
      employeeId: string,
      moOperationId: string,
      createdBy: string,
      kind: TimeKind | null = null,
      check?: (locked: StampTargetState) => void
    ) {
      return db.transaction(async (tx) => {
        const [op] = await tx
          .select({
            workCenterId: moOperations.workCenterId,
            status: moOperations.status,
            manufacturingOrderId: moOperations.manufacturingOrderId,
          })
          .from(moOperations)
          .where(eq(moOperations.id, moOperationId))
          .for("key share");
        // An unknown operation fails on the FK below, as before.
        if (op && check) {
          const [order] = await tx
            .select({ status: manufacturingOrders.status })
            .from(manufacturingOrders)
            .where(eq(manufacturingOrders.id, op.manufacturingOrderId))
            .for("share");
          check({ workCenterId: op.workCenterId, operationStatus: op.status, orderStatus: order?.status ?? null });
        }
        const [row] = await tx
          .insert(stampSessions)
          .values({ employeeId, moOperationId, createdBy, kind, workCenterId: op?.workCenterId ?? null })
          .returning();
        return row!;
      });
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
    async listStampSessions(onlyOpen: boolean, opts: { employeeId?: string; absenceDate?: string } = {}) {
      return stampSessionRows(
        and(
          onlyOpen ? isNull(stampSessions.stoppedAt) : undefined,
          opts.employeeId ? eq(stampSessions.employeeId, opts.employeeId) : undefined
        ),
        opts.absenceDate
      );
    },

    // The history (GET /stamp-sessions without ?open=true) in the list
    // pattern: one where for the page and its count. Search on the
    // employee's name/number and the order number.
    async pageStampSessions(query: { employeeId?: string; search?: string; limit: number; offset: number; absenceDate?: string }) {
      const pattern = query.search ? ilikePattern(query.search) : null;
      const where = and(
        query.employeeId ? eq(stampSessions.employeeId, query.employeeId) : undefined,
        pattern
          ? or(ilike(employees.name, pattern), ilike(employees.employeeNumber, pattern), ilike(manufacturingOrders.orderNumber, pattern))
          : undefined
      );
      const [rows, [totalRow]] = await Promise.all([
        stampSessionRows(where, query.absenceDate).limit(query.limit).offset(query.offset),
        db
          .select({ total: count() })
          .from(stampSessions)
          .innerJoin(employees, eq(employees.id, stampSessions.employeeId))
          .innerJoin(moOperations, eq(moOperations.id, stampSessions.moOperationId))
          .innerJoin(manufacturingOrders, eq(manufacturingOrders.id, moOperations.manufacturingOrderId))
          .where(where),
      ]);
      return { rows, total: totalRow?.total ?? 0 };
    },

    // Conditional: a stamp closed in between (regel 10 stamping it out when
    // the operation turned done) is not closed twice — null tells the caller.
    async closeStampSession(id: string, stoppedAt: Date, timeReportId: string) {
      const [row] = await db
        .update(stampSessions)
        .set({ stoppedAt, timeReportId })
        .where(and(eq(stampSessions.id, id), isNull(stampSessions.stoppedAt)))
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
    // date/hours/note/kind before calling in, so this is a plain overwrite.
    async updateTimeReport(id: string, patch: { date: string; hours: number; note: string | null; kind: TimeKind | null }) {
      const [row] = await db
        .update(timeReports)
        .set({ date: patch.date, hours: String(patch.hours), note: patch.note, kind: patch.kind })
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

    // The employee's own fields and its Förvalda stationer (replace-the-set,
    // when defaultWorkCenterIds is given) change in one transaction. The
    // employee row is locked first — by the UPDATE, or FOR UPDATE when only
    // the set changes (an empty .set() would throw) — so concurrent PATCHes
    // of the same employee replace the set one after the other.
    async updateEmployee(id: string, input: UpdateEmployeeInput) {
      const { defaultWorkCenterIds, ...fields } = input;
      return db.transaction(async (tx) => {
        const hasFields = Object.values(fields).some((value) => value !== undefined);
        const [row] = hasFields
          ? await tx
              .update(employees)
              .set({
                ...fields,
                wage: fields.wage === undefined ? undefined : fields.wage === null ? null : String(fields.wage),
                weeklyHours:
                  fields.weeklyHours === undefined
                    ? undefined
                    : fields.weeklyHours === null
                      ? null
                      : String(fields.weeklyHours),
              })
              .where(eq(employees.id, id))
              .returning()
          : await tx.select().from(employees).where(eq(employees.id, id)).for("update");
        if (!row) return null;
        if (defaultWorkCenterIds !== undefined) {
          await tx.delete(employeeWorkCenters).where(eq(employeeWorkCenters.employeeId, id));
          const unique = [...new Set(defaultWorkCenterIds)];
          if (unique.length > 0) {
            await tx.insert(employeeWorkCenters).values(unique.map((workCenterId) => ({ employeeId: id, workCenterId })));
          }
        }
        return row;
      });
    },

    // Kom (and a work stamp that clocks the employee in): resumes the work
    // the previous Gå hem paused and opens the attendance in ONE
    // transaction. A concurrent clock-in fails on ONE_OPEN_ATTENDANCE and
    // rolls the resume back with it.
    async beginAttendance(employeeId: string, createdBy: string, reason: StampReason, startedAt: Date) {
      return db.transaction(async (tx) => {
        await resumeOpenStampSessions(employeeId, startedAt, tx);
        const [row] = await tx
          .insert(attendanceSessions)
          .values({ employeeId, createdBy, startReasonId: reason.reasonId, startNote: reason.note, startedAt })
          .returning();
        return row!;
      });
    },

    // An attendance row as is — the test fixtures' primitive; the service
    // clocks in through beginAttendance.
    async createAttendanceSession(employeeId: string, createdBy: string, reason: StampReason = NO_REASON, startedAt?: Date) {
      const [row] = await db
        .insert(attendanceSessions)
        .values({ employeeId, createdBy, startReasonId: reason.reasonId, startNote: reason.note, startedAt })
        .returning();
      return row!;
    },

    // Sen ankomst: does an attendance of the employee already overlap the
    // schedule window [from, to) — closed or still open? The arrival is only
    // asked about when it becomes the day's first presence in the window
    // (overlapsScheduleWindow, the payroll rule). `excludeId` leaves out the
    // forgotten attendance closeForgottenAndBegin is about to close (its
    // stop time is judged by the caller).
    async hasAttendanceInWindow(employeeId: string, from: Date, to: Date, excludeId?: string) {
      const [row] = await db
        .select({ id: attendanceSessions.id })
        .from(attendanceSessions)
        .where(
          and(
            eq(attendanceSessions.employeeId, employeeId),
            lt(attendanceSessions.startedAt, to),
            or(isNull(attendanceSessions.stoppedAt), gt(attendanceSessions.stoppedAt, from)),
            excludeId ? ne(attendanceSessions.id, excludeId) : undefined
          )
        )
        .limit(1);
      return row !== undefined;
    },

    async findAttendanceDeviationReason(id: string) {
      const [row] = await db.select().from(attendanceDeviationReasons).where(eq(attendanceDeviationReasons.id, id));
      return row ?? null;
    },

    async listAttendanceDeviationReasonsByIds(ids: string[]) {
      if (ids.length === 0) return [];
      return db.select().from(attendanceDeviationReasons).where(inArray(attendanceDeviationReasons.id, ids));
    },

    // Ta ut ATF's withdrawal, for the early-departure exemption.
    async findAtfTransactionById(id: string) {
      const [row] = await db.select().from(atfTransactions).where(eq(atfTransactions.id, id));
      return row ?? null;
    },

    // Tidig hemgång: any ATF withdrawal by the employee dated this day
    // explains leaving early — the same rule as the attestation's
    // Avvikelser (a day with ATF minutes never misses a reason).
    async hasAtfWithdrawalOnDay(employeeId: string, date: string) {
      const [row] = await db
        .select({ id: atfTransactions.id })
        .from(atfTransactions)
        .where(
          and(
            eq(atfTransactions.employeeId, employeeId),
            eq(atfTransactions.type, "withdrawal"),
            eq(atfTransactions.date, date)
          )
        )
        .limit(1);
      return row !== undefined;
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

    async findOpenAttendanceSession(employeeId: string) {
      const [row] = await db
        .select()
        .from(attendanceSessions)
        .where(and(eq(attendanceSessions.employeeId, employeeId), isNull(attendanceSessions.stoppedAt)))
        .limit(1);
      return row ?? null;
    },

    async listAttendanceSessions(onlyOpen: boolean) {
      return attendanceSessionRows(onlyOpen ? isNull(attendanceSessions.stoppedAt) : undefined);
    },

    // The history (GET /attendance-sessions without ?open=true) in the list
    // pattern; search on the employee's name/number.
    async pageAttendanceSessions(query: { employeeId?: string; search?: string; limit: number; offset: number }) {
      const pattern = query.search ? ilikePattern(query.search) : null;
      const where = and(
        query.employeeId ? eq(attendanceSessions.employeeId, query.employeeId) : undefined,
        pattern ? or(ilike(employees.name, pattern), ilike(employees.employeeNumber, pattern)) : undefined
      );
      const [rows, [totalRow]] = await Promise.all([
        attendanceSessionRows(where).limit(query.limit).offset(query.offset),
        db
          .select({ total: count() })
          .from(attendanceSessions)
          .innerJoin(employees, eq(employees.id, attendanceSessions.employeeId))
          .where(where),
      ]);
      return { rows, total: totalRow?.total ?? 0 };
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
          startReasonId: attendanceSessions.startReasonId,
          startNote: attendanceSessions.startNote,
          stopReasonId: attendanceSessions.stopReasonId,
          stopNote: attendanceSessions.stopNote,
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

    closeAttendanceSession,

    // Gå hem in one transaction: close the attendance (with its reason),
    // pause the employee's open work at the same instant, then `inTx` — the
    // day's overtime choice, written only after the close succeeded so a
    // losing concurrent Gå hem writes nothing. Null when the attendance was
    // already stopped.
    async stopAttendance(
      id: string,
      employeeId: string,
      at: Date,
      reason: StampReason,
      inTx: (tx: Tx) => Promise<void>
    ) {
      return db.transaction(async (tx) => {
        const session = await closeAttendanceSession(id, at, reason, tx);
        if (!session) return null;
        const pausedWorkSessions = await pauseOpenStampSessions(employeeId, at, tx);
        await inTx(tx);
        return { session, pausedWorkSessions };
      });
    },

    // Regel 7: a supervisor's attendance correction carries over to the work
    // stamps, in one transaction. Called with the already-merged final
    // values. "pause": the attendance was open and now has a stop time —
    // open, unpaused work that started before it pauses there (work started
    // after it is today's and is left alone). "move": the stop time moved —
    // work still paused since the old stop (2 s tolerance: Gå hem used to
    // stamp the pause and the stop with separate clocks) follows to the new
    // one. Work resumed since is never touched.
    //
    // The patch carries only the columns the supervisor changed, and the
    // write is conditional on BOTH times the service read (`expected`,
    // compared to the millisecond like the freight module's optimistic
    // writes — JS dates have ms, Postgres µs): a Gå hem at the terminal in
    // between would otherwise be undone by a correction that only meant to
    // change a reason (it would write the stale "still open" back), and a
    // second supervisor moving the start meanwhile would let a stop time
    // validated against the old start land before the new one. A miss
    // returns `session: null` with nothing written; the service answers 409.
    async correctAttendanceWithWork(
      id: string,
      patch: Partial<{
        startedAt: Date;
        stoppedAt: Date | null;
        startReasonId: string | null;
        startNote: string | null;
        stopReasonId: string | null;
        stopNote: string | null;
      }>,
      expected: { startedAt: Date; stoppedAt: Date | null },
      effect:
        | { kind: "pause"; employeeId: string; at: Date }
        | { kind: "move"; employeeId: string; from: Date; to: Date }
        | null
    ) {
      return db.transaction(async (tx) => {
        // The period guard first, before any row lock: every Stockholm day
        // the session touched or will touch (the write below is conditional
        // on the expected times, so these are the row's real days) lies in
        // an open payroll period that stays open until the commit.
        await assertPayrollPeriodsOpenInTx(
          tx,
          [expected.startedAt, expected.stoppedAt, patch.startedAt, patch.stoppedAt].flatMap((t) => (t ? [localDateOf(t)] : []))
        );
        const where = and(eq(attendanceSessions.id, id), unchangedTimes(expected));
        const [session] =
          Object.keys(patch).length === 0
            ? await tx.select().from(attendanceSessions).where(where).for("update")
            : await tx.update(attendanceSessions).set(patch).where(where).returning();
        if (!session) return { session: null, pausedWorkSessions: 0, movedPauses: 0 };
        let pausedWorkSessions = 0;
        let movedPauses = 0;
        if (effect?.kind === "pause") {
          const rows = await tx
            .update(stampSessions)
            .set({ pausedAt: effect.at })
            .where(
              and(
                eq(stampSessions.employeeId, effect.employeeId),
                isNull(stampSessions.stoppedAt),
                isNull(stampSessions.pausedAt),
                lt(stampSessions.startedAt, effect.at)
              )
            )
            .returning({ id: stampSessions.id });
          pausedWorkSessions = rows.length;
        } else if (effect?.kind === "move") {
          const rows = await tx
            .update(stampSessions)
            // Never before the stamp's own start: a stamp begun after the
            // new stop time pauses where it started (no negative stint).
            .set({ pausedAt: sql`greatest(${effect.to.toISOString()}::timestamptz, ${stampSessions.startedAt})` })
            .where(
              and(
                eq(stampSessions.employeeId, effect.employeeId),
                isNull(stampSessions.stoppedAt),
                sql`abs(extract(epoch from (${stampSessions.pausedAt} - ${effect.from.toISOString()}::timestamptz))) < 2`
              )
            )
            .returning({ id: stampSessions.id });
          movedPauses = rows.length;
        }
        return { session, pausedWorkSessions, movedPauses };
      });
    },

    // Regel 8: the forgotten Gå hem and today's attendance-in as one
    // transaction — close the old attendance at the given time (pausing the
    // open work that started before it, as Gå hem would have), resume all
    // paused work now and open today's attendance. The close only takes a
    // still-open attendance: a second, stale call (double tap, retry, two
    // terminals) gets null before any stamp is touched — otherwise it would
    // pause and resume the same work again and add the night to
    // paused_seconds twice.
    async closeForgottenAndBegin(
      employeeId: string,
      staleId: string,
      forgottenStoppedAt: Date,
      now: Date,
      createdBy: string,
      reason: StampReason = NO_REASON
    ) {
      return db.transaction(async (tx) => {
        // The period guard first (the forgotten attendance may lie in last
        // month): its start is read without a row lock, and the close below
        // only takes the attendance while that start still stands.
        const [stale] = await tx
          .select({ startedAt: attendanceSessions.startedAt })
          .from(attendanceSessions)
          .where(and(eq(attendanceSessions.id, staleId), isNull(attendanceSessions.stoppedAt)));
        if (!stale) return null;
        await assertPayrollPeriodsOpenInTx(tx, [localDateOf(stale.startedAt), localDateOf(forgottenStoppedAt)]);
        const closed = await tx
          .update(attendanceSessions)
          .set({ stoppedAt: forgottenStoppedAt })
          .where(and(eq(attendanceSessions.id, staleId), unchangedTimes({ startedAt: stale.startedAt, stoppedAt: null })))
          .returning({ id: attendanceSessions.id });
        if (closed.length === 0) return null;
        await tx
          .update(stampSessions)
          .set({ pausedAt: forgottenStoppedAt })
          .where(
            and(
              eq(stampSessions.employeeId, employeeId),
              isNull(stampSessions.stoppedAt),
              isNull(stampSessions.pausedAt),
              lt(stampSessions.startedAt, forgottenStoppedAt)
            )
          );
        await resumeOpenStampSessions(employeeId, now, tx);
        const [session] = await tx
          .insert(attendanceSessions)
          .values({ employeeId, createdBy, startReasonId: reason.reasonId, startNote: reason.note, startedAt: now })
          .returning();
        return session!;
      });
    },

    // Does not touch stamp_sessions — work stamps are independent of
    // attendance, and pause bookkeeping on them stays historical.
    //
    // Under the period guard: the row's days are read without a row lock,
    // their months are taken, and the delete only removes the row those
    // days were read from — a correction that moved it in between is read
    // again (its new months guarded too).
    async deleteAttendanceSession(id: string) {
      return db.transaction(async (tx) => {
        for (let attempt = 0; attempt < 5; attempt++) {
          const [existing] = await tx
            .select({ startedAt: attendanceSessions.startedAt, stoppedAt: attendanceSessions.stoppedAt })
            .from(attendanceSessions)
            .where(eq(attendanceSessions.id, id));
          if (!existing) return null;
          // Only a closed attendance (the service refuses an open one; a
          // re-opening in between is caught here).
          if (existing.stoppedAt === null) return "open" as const;
          await assertPayrollPeriodsOpenInTx(tx, [localDateOf(existing.startedAt), localDateOf(existing.stoppedAt)]);
          const [row] = await tx
            .delete(attendanceSessions)
            .where(and(eq(attendanceSessions.id, id), unchangedTimes(existing)))
            .returning();
          if (row) return row;
        }
        throw new Error(`Attendance session ${id} kept changing while it was being deleted`);
      });
    },

    async listOpenStampSessionIdsByEmployee(employeeId: string) {
      const rows = await db
        .select({ id: stampSessions.id })
        .from(stampSessions)
        .where(and(eq(stampSessions.employeeId, employeeId), isNull(stampSessions.stoppedAt)));
      return rows.map((r) => r.id);
    },

    pauseOpenStampSessions,
  };
}

export type TimeReportRepository = ReturnType<typeof createTimeReportRepository>;
