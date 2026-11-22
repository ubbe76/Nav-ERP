// Stämplingar (Personal & lön, 2026-11-22): the stamp side of a corrected,
// afterwards-registered or removed work stamp, written inside the
// manufacturing report's transaction (ManufacturingService.replaceStampReport
// and its StampReportLink). A leaf — schema imports only.
import { and, eq, sql } from "drizzle-orm";
import { stampSessions, timeReports, type Tx } from "@navet/db";
import type { TimeKind } from "@navet/shared";

// The stamp as it was read before the correction: the writes below only
// touch it while it still is (a correction in between ⇒ nothing written and
// the caller rolls back with 409). time_report_id is left out on purpose —
// the undo in the same transaction deletes the old time report, which sets
// it to null (ON DELETE SET NULL).
export interface StampExpected {
  id: string;
  moOperationId: string;
  startedAt: Date;
  stoppedAt: Date;
  pausedSeconds: string;
  kind: TimeKind | null;
}

export function stampUnchanged(expected: StampExpected) {
  return and(
    eq(stampSessions.id, expected.id),
    eq(stampSessions.moOperationId, expected.moOperationId),
    // To the millisecond (JS dates have ms, Postgres µs), as the attendance
    // corrections compare (unchangedTimes in timereport.repository.ts).
    sql`abs(extract(epoch from (${stampSessions.startedAt} - ${expected.startedAt.toISOString()}::timestamptz))) < 0.001`,
    sql`abs(extract(epoch from (${stampSessions.stoppedAt} - ${expected.stoppedAt.toISOString()}::timestamptz))) < 0.001`,
    sql`${stampSessions.pausedSeconds} = ${expected.pausedSeconds}::numeric`,
    sql`${stampSessions.kind} is not distinct from ${expected.kind}::time_kind`
  );
}

export interface StampValues {
  moOperationId: string;
  startedAt: Date;
  stoppedAt: Date;
  pausedSeconds: number;
  kind: TimeKind | null;
  workCenterId: string | null;
}

export async function insertTimeReportInTx(
  tx: Tx,
  values: {
    employeeId: string;
    moOperationId: string;
    date: string;
    hours: number;
    kind: TimeKind | null;
    workCenterId: string | null;
    note: string | null;
    createdBy: string;
  }
): Promise<string> {
  const [row] = await tx
    .insert(timeReports)
    .values({ ...values, hours: String(values.hours) })
    .returning({ id: timeReports.id });
  return row!.id;
}

// The stamp rewritten after its report was redone. False = it changed since
// it was read.
export async function rewriteStampInTx(tx: Tx, expected: StampExpected, values: StampValues, timeReportId: string): Promise<boolean> {
  const rows = await tx
    .update(stampSessions)
    .set({ ...values, pausedSeconds: String(values.pausedSeconds), pausedAt: null, timeReportId })
    .where(stampUnchanged(expected))
    .returning({ id: stampSessions.id });
  return rows.length > 0;
}

export async function deleteStampInTx(tx: Tx, expected: StampExpected): Promise<boolean> {
  const rows = await tx.delete(stampSessions).where(stampUnchanged(expected)).returning({ id: stampSessions.id });
  return rows.length > 0;
}

// A stamp registered afterwards: closed from the start.
export async function insertClosedStampInTx(
  tx: Tx,
  values: StampValues & { employeeId: string; timeReportId: string; createdBy: string }
): Promise<string> {
  const [row] = await tx
    .insert(stampSessions)
    .values({ ...values, pausedSeconds: String(values.pausedSeconds) })
    .returning({ id: stampSessions.id });
  return row!.id;
}
