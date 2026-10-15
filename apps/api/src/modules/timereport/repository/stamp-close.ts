import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { moOperations, payrollPeriods, stampSessions, timeReports, type Db, type Tx } from "@navet/db";

// Leaf on purpose: the manufacturing repository calls closeStampSessionsInTx
// inside its own report/complete transactions (an operation or order turning
// done stamps out everyone else on it — regel 10), and the timereport
// service uses stampedHours for every stamp-out. Imports nothing but the
// schema, so neither module can form a cycle through it.

export type StampTimes = { startedAt: Date; pausedAt: Date | null; pausedSeconds: string | number };

// Worked hours: start → stop minus finished pauses (pausedSeconds) and an
// ongoing pause up to the stop time. A stop chosen before the ongoing pause
// began counts no part of it. Finished pauses are always subtracted — the
// stamp only stores their total, not when they happened (known
// approximation when a supervisor picks an early stop time).
export function stampedHours(session: StampTimes, stoppedAt: Date): number {
  const ongoingPauseMs = session.pausedAt ? Math.max(stoppedAt.getTime() - session.pausedAt.getTime(), 0) : 0;
  const pausedMs = Number(session.pausedSeconds) * 1000 + ongoingPauseMs;
  const elapsedHours = (stoppedAt.getTime() - session.startedAt.getTime() - pausedMs) / 3_600_000;
  return Math.max(0.01, Math.round(elapsedHours * 100) / 100);
}

// A paused stamp (gone home and never back) stopped when the pause began.
export function effectiveStopTime(session: { pausedAt: Date | null }, at: Date): Date {
  return session.pausedAt ?? at;
}

// sv-SE formats ISO-style (YYYY-MM-DD).
const stockholmDate = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm" });

// The Stockholm day of an instant, YYYY-MM-DD — the API container may run
// UTC, so the zone is explicit rather than the server's local time.
export function localDateOf(instant: Date): string {
  return stockholmDate.format(instant);
}

// Same rule as payroll's createPeriodLockChecker (the calendar month's row
// is locked), read inside the caller's transaction.
export async function isPayrollDateLockedInTx(dbc: Db | Tx, date: string): Promise<boolean> {
  const [row] = await dbc
    .select({ status: payrollPeriods.status })
    .from(payrollPeriods)
    .where(and(eq(payrollPeriods.year, Number(date.slice(0, 4))), eq(payrollPeriods.month, Number(date.slice(5, 7)))));
  return row?.status === "locked";
}

export type AutoClosedStamp = { sessionId: string; moOperationId: string; employeeId: string; timeReportId: string };

// Regel 10: stamps out every open (or paused) stamp on the given operations
// or on every operation of the order — 0/0, no quantities, the time up to
// the pause start (paused) or `at`. The time report is dated on the stop
// time's day, or today when that day lies in a locked payroll period: an old
// paused stamp must never block an operation from turning done. The caller
// writes the matching mo_reports rows (the manufacturing repository owns
// that table's row shape).
export async function closeStampSessionsInTx(
  dbc: Db | Tx,
  opts: { operationIds?: string[]; orderId?: string; at: Date; createdBy: string | null; note: string }
): Promise<AutoClosedStamp[]> {
  if (!opts.orderId && (opts.operationIds ?? []).length === 0) return [];
  const scope = opts.orderId
    ? inArray(
        stampSessions.moOperationId,
        dbc.select({ id: moOperations.id }).from(moOperations).where(eq(moOperations.manufacturingOrderId, opts.orderId))
      )
    : inArray(stampSessions.moOperationId, opts.operationIds ?? []);

  const open = await dbc
    .select()
    .from(stampSessions)
    .where(and(scope, isNull(stampSessions.stoppedAt)))
    .orderBy(asc(stampSessions.id))
    .for("update");

  const closed: AutoClosedStamp[] = [];
  for (const session of open) {
    const stoppedAt = effectiveStopTime(session, opts.at);
    const hours = stampedHours(session, stoppedAt);
    const stopDate = localDateOf(stoppedAt);
    const date = (await isPayrollDateLockedInTx(dbc, stopDate)) ? localDateOf(opts.at) : stopDate;
    const [report] = await dbc
      .insert(timeReports)
      .values({
        employeeId: session.employeeId,
        moOperationId: session.moOperationId,
        date,
        hours: String(hours),
        note: opts.note,
        createdBy: opts.createdBy,
      })
      .returning({ id: timeReports.id });
    await dbc
      .update(stampSessions)
      .set({ stoppedAt, timeReportId: report!.id })
      .where(eq(stampSessions.id, session.id));
    closed.push({
      sessionId: session.id,
      moOperationId: session.moOperationId,
      employeeId: session.employeeId,
      timeReportId: report!.id,
    });
  }
  return closed;
}
