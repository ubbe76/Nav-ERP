import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { atfTransactions, type Db } from "@navet/db";
import type { CreateAtfTransactionInput } from "@navet/shared";

export function createAtfRepository(db: Db) {
  return {
    async listAtfTransactions(employeeId: string) {
      return db
        .select()
        .from(atfTransactions)
        .where(eq(atfTransactions.employeeId, employeeId))
        .orderBy(desc(atfTransactions.date), desc(atfTransactions.createdAt));
    },

    async createAtfTransaction(employeeId: string, input: CreateAtfTransactionInput, createdBy: string) {
      const [row] = await db
        .insert(atfTransactions)
        .values({
          employeeId,
          date: input.date,
          type: input.type,
          minutes: input.minutes,
          note: input.note,
          createdBy,
        })
        .returning();
      return row!;
    },

    // Read before delete — the period-lock guard needs the row's date.
    async findAtfTransaction(employeeId: string, id: string) {
      const [row] = await db
        .select()
        .from(atfTransactions)
        .where(and(eq(atfTransactions.id, id), eq(atfTransactions.employeeId, employeeId)));
      return row ?? null;
    },

    async deleteAtfTransaction(employeeId: string, id: string) {
      const [row] = await db
        .delete(atfTransactions)
        .where(and(eq(atfTransactions.id, id), eq(atfTransactions.employeeId, employeeId)))
        .returning();
      return row ?? null;
    },

    // Withdrawals in a date range, all employees — feeds the payroll period
    // summary (adjustments don't affect a specific day's basis, so they're
    // excluded here).
    async listWithdrawalsInRange(from: string, to: string) {
      return db
        .select({
          employeeId: atfTransactions.employeeId,
          date: atfTransactions.date,
          minutes: atfTransactions.minutes,
        })
        .from(atfTransactions)
        .where(
          and(eq(atfTransactions.type, "withdrawal"), gte(atfTransactions.date, from), lte(atfTransactions.date, to))
        );
    },

    // Withdrawn/adjusted minute totals — the derived accrual is added on top
    // by the service.
    async sumAtfTransactions(employeeId: string) {
      const [row] = await db
        .select({
          withdrawnMinutes: sql<number>`coalesce(sum(${atfTransactions.minutes}) filter (where ${atfTransactions.type} = 'withdrawal'), 0)::int`,
          adjustedMinutes: sql<number>`coalesce(sum(${atfTransactions.minutes}) filter (where ${atfTransactions.type} = 'adjustment'), 0)::int`,
        })
        .from(atfTransactions)
        .where(eq(atfTransactions.employeeId, employeeId));
      return row!;
    },
  };
}

export type AtfRepository = ReturnType<typeof createAtfRepository>;
