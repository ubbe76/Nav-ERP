import { eq } from "drizzle-orm";
import { attendanceSessions, employeeTerminalPins, employees, stampSessions, type Db, type Tx } from "@navet/db";

// Terminalkod (migration 0233, timereport.md). The pin row is the lock every
// attempt is counted under.

export function createTerminalPinRepository(db: Db) {
  return {
    // What a code needs to know of the employee — never the whole row.
    async findEmployee(executor: Db | Tx, employeeId: string) {
      const [row] = await executor
        .select({
          id: employees.id,
          employeeNumber: employees.employeeNumber,
          active: employees.active,
          anonymizedAt: employees.anonymizedAt,
        })
        .from(employees)
        .where(eq(employees.id, employeeId));
      return row ?? null;
    },

    async findPin(employeeId: string) {
      const [row] = await db.select().from(employeeTerminalPins).where(eq(employeeTerminalPins.employeeId, employeeId));
      return row ?? null;
    },

    // The same row, locked: two simultaneous attempts are counted one after
    // the other, never both against the same number of earlier failures.
    async lockPin(tx: Tx, employeeId: string) {
      const [row] = await tx
        .select()
        .from(employeeTerminalPins)
        .where(eq(employeeTerminalPins.employeeId, employeeId))
        .for("update");
      return row ?? null;
    },

    // Välj en kod: only when none is chosen. Two simultaneous choices are
    // decided by the primary key — the loser gets null (a code already exists).
    async insertPin(employeeId: string, pinHash: string) {
      const [row] = await db
        .insert(employeeTerminalPins)
        .values({ employeeId, pinHash })
        .onConflictDoNothing()
        .returning({ setAt: employeeTerminalPins.setAt });
      return row ?? null;
    },

    async recordSuccess(tx: Tx, employeeId: string) {
      await tx
        .update(employeeTerminalPins)
        .set({ failedAttempts: 0, lockedUntil: null })
        .where(eq(employeeTerminalPins.employeeId, employeeId));
    },

    async recordFailure(tx: Tx, employeeId: string, failedAttempts: number, lockedUntil: Date | null) {
      await tx
        .update(employeeTerminalPins)
        .set({ failedAttempts, lockedUntil })
        .where(eq(employeeTerminalPins.employeeId, employeeId));
    },

    // Nollställ terminalkoden: the code, the counter and the spärr go at once.
    async deletePin(employeeId: string) {
      const rows = await db
        .delete(employeeTerminalPins)
        .where(eq(employeeTerminalPins.employeeId, employeeId))
        .returning({ employeeId: employeeTerminalPins.employeeId });
      return rows.length > 0;
    },

    // Whose stamp or attendance a stop acts on (the guard's lookup).
    async employeeOfStampSession(sessionId: string) {
      const [row] = await db.select({ employeeId: stampSessions.employeeId }).from(stampSessions).where(eq(stampSessions.id, sessionId));
      return row?.employeeId ?? null;
    },

    async employeeOfAttendanceSession(sessionId: string) {
      const [row] = await db
        .select({ employeeId: attendanceSessions.employeeId })
        .from(attendanceSessions)
        .where(eq(attendanceSessions.id, sessionId));
      return row?.employeeId ?? null;
    },

    transaction<T>(fn: (tx: Tx) => Promise<T>) {
      return db.transaction(fn);
    },

    db,
  };
}

export type TerminalPinRepository = ReturnType<typeof createTerminalPinRepository>;
