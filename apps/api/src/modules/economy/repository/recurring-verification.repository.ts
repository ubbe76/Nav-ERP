import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import {
  fiscalYears,
  recurringVerificationRuns,
  recurringVerifications,
  verificationSeries,
  verificationTemplates,
  verifications,
  type Db,
  type RecurringAllocation,
  type RecurringScheduleAmounts,
  type Tx,
} from "@navet/db";
import type { RecurringVerificationMode } from "@navet/shared";

// Återkommande verifikat — the rows and the run log. The run log's unique
// (recurring_id, month) is the job's reservation: insertRunInTx writes the
// `created` row in the SAME transaction as the verification it points at
// (a concurrent writer's insert blocks on the uncommitted row and then does
// nothing), recordFailure writes a `failed` row afterwards that blocks
// automatic retries until Kör nu removes it, and insertSkippedRunsInTx writes
// the `skipped` rows for the months that passed while the post was paused —
// in the same transaction as the activation, so the job never creates them.

export interface RecurringRow {
  id: string;
  templateId: string;
  templateName: string;
  templateDescription: string;
  templateSeriesId: string;
  dayOfMonth: number | null;
  startMonth: string;
  endMonth: string | null;
  mode: RecurringVerificationMode;
  active: boolean;
  scheduleAmounts: RecurringScheduleAmounts | null;
  allocation: RecurringAllocation | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type RecurringRunStatus = "created" | "failed" | "skipped";

export interface RecurringRunRow {
  id: string;
  recurringId: string | null;
  month: string;
  status: RecurringRunStatus;
  error: string | null;
  verificationId: string | null;
  // Built here (series code + year label + number), null for a draft.
  verificationDisplayNumber: string | null;
  createdAt: Date;
}

export type RecurringWrite = {
  templateId: string;
  dayOfMonth: number | null;
  startMonth: string;
  endMonth: string | null;
  mode: RecurringVerificationMode;
  scheduleAmounts: RecurringScheduleAmounts | null;
  allocation: RecurringAllocation | null;
};

export type RecurringPatch = Partial<Pick<RecurringWrite, "dayOfMonth" | "endMonth" | "mode">> & { active?: boolean };

export function createRecurringVerificationRepository(db: Db) {
  const selection = {
    id: recurringVerifications.id,
    templateId: recurringVerifications.templateId,
    templateName: verificationTemplates.name,
    templateDescription: verificationTemplates.description,
    templateSeriesId: verificationTemplates.seriesId,
    dayOfMonth: recurringVerifications.dayOfMonth,
    startMonth: recurringVerifications.startMonth,
    endMonth: recurringVerifications.endMonth,
    mode: recurringVerifications.mode,
    active: recurringVerifications.active,
    scheduleAmounts: recurringVerifications.scheduleAmounts,
    allocation: recurringVerifications.allocation,
    createdBy: recurringVerifications.createdBy,
    createdAt: recurringVerifications.createdAt,
    updatedAt: recurringVerifications.updatedAt,
  };

  function query(executor: Db | Tx) {
    return executor
      .select(selection)
      .from(recurringVerifications)
      .innerJoin(verificationTemplates, eq(verificationTemplates.id, recurringVerifications.templateId));
  }

  return {
    async list(): Promise<RecurringRow[]> {
      return query(db).orderBy(asc(verificationTemplates.name), asc(recurringVerifications.startMonth));
    },

    async listActive(): Promise<RecurringRow[]> {
      return query(db).where(eq(recurringVerifications.active, true)).orderBy(asc(recurringVerifications.createdAt));
    },

    async findById(id: string, executor: Db | Tx = db): Promise<RecurringRow | null> {
      const [row] = await query(executor).where(eq(recurringVerifications.id, id));
      return row ?? null;
    },

    // Every run of the given posts, newest month first, with the booked
    // verification's number when there is one.
    async runsFor(recurringIds: string[], executor: Db | Tx = db): Promise<Map<string, RecurringRunRow[]>> {
      const byRecurring = new Map<string, RecurringRunRow[]>();
      if (recurringIds.length === 0) return byRecurring;
      const rows = await executor
        .select({
          id: recurringVerificationRuns.id,
          recurringId: recurringVerificationRuns.recurringId,
          month: recurringVerificationRuns.month,
          status: recurringVerificationRuns.status,
          error: recurringVerificationRuns.error,
          verificationId: recurringVerificationRuns.verificationId,
          verificationStatus: verifications.status,
          verificationNumber: verifications.verificationNumber,
          seriesCode: verificationSeries.code,
          yearLabel: fiscalYears.label,
          createdAt: recurringVerificationRuns.createdAt,
        })
        .from(recurringVerificationRuns)
        .leftJoin(verifications, eq(verifications.id, recurringVerificationRuns.verificationId))
        .leftJoin(verificationSeries, eq(verificationSeries.id, verifications.seriesId))
        .leftJoin(fiscalYears, eq(fiscalYears.id, verifications.fiscalYearId))
        .where(inArray(recurringVerificationRuns.recurringId, recurringIds))
        .orderBy(desc(recurringVerificationRuns.month), desc(recurringVerificationRuns.createdAt));
      for (const row of rows) {
        const list = byRecurring.get(row.recurringId!) ?? [];
        list.push({
          id: row.id,
          recurringId: row.recurringId,
          month: row.month,
          status: row.status,
          error: row.error,
          verificationId: row.verificationId,
          verificationDisplayNumber:
            row.verificationStatus === "booked" && row.verificationNumber !== null
              ? `${row.seriesCode}-${row.yearLabel}-${row.verificationNumber}`
              : null,
          createdAt: row.createdAt,
        });
        byRecurring.set(row.recurringId!, list);
      }
      return byRecurring;
    },

    async create(write: RecurringWrite, createdBy: string | null, tx?: Tx): Promise<string> {
      const run = async (t: Db | Tx) => {
        const [row] = await t
          .insert(recurringVerifications)
          .values({ ...write, createdBy })
          .returning({ id: recurringVerifications.id });
        return row!.id;
      };
      return run(tx ?? db);
    },

    async update(id: string, patch: RecurringPatch, executor: Db | Tx = db): Promise<boolean> {
      const [row] = await executor
        .update(recurringVerifications)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(recurringVerifications.id, id))
        .returning({ id: recurringVerifications.id });
      return row !== undefined;
    },

    // Removes the post. Runs that created a verification keep their row
    // (recurring_id → null, the verification's only link to its origin);
    // failed and skipped runs carry nothing and go with the post.
    // deleteTemplate: a fördelning's own template goes with the post — unless
    // another post has come to use it (the template is editable), in which
    // case it stays: the restrict FK would otherwise fail the whole delete.
    async delete(id: string, deleteTemplate = false): Promise<boolean> {
      return db.transaction(async (tx) => {
        await tx
          .delete(recurringVerificationRuns)
          .where(and(eq(recurringVerificationRuns.recurringId, id), ne(recurringVerificationRuns.status, "created")));
        const [row] = await tx
          .delete(recurringVerifications)
          .where(eq(recurringVerifications.id, id))
          .returning({ id: recurringVerifications.id, templateId: recurringVerifications.templateId });
        if (row && deleteTemplate) {
          const [other] = await tx
            .select({ one: sql`1` })
            .from(recurringVerifications)
            .where(eq(recurringVerifications.templateId, row.templateId))
            .limit(1);
          if (!other) await tx.delete(verificationTemplates).where(eq(verificationTemplates.id, row.templateId));
        }
        return row !== undefined;
      });
    },

    // The reservation, written in the same transaction as the verification:
    // null when another writer already holds the month (its row committed
    // first), which the caller turns into a rollback of its verification.
    async insertRunInTx(tx: Tx, recurringId: string, month: string, verificationId: string): Promise<string | null> {
      const [row] = await tx
        .insert(recurringVerificationRuns)
        .values({ recurringId, month, status: "created", verificationId })
        .onConflictDoNothing({ target: [recurringVerificationRuns.recurringId, recurringVerificationRuns.month] })
        .returning({ id: recurringVerificationRuns.id });
      return row?.id ?? null;
    },

    // A failed month, after the creating transaction rolled back. ON
    // CONFLICT DO NOTHING: if a concurrent run succeeded in between, the
    // success stands and this failure is dropped.
    async recordFailure(recurringId: string, month: string, error: string): Promise<string | null> {
      const [row] = await db
        .insert(recurringVerificationRuns)
        .values({ recurringId, month, status: "failed", error: error.slice(0, 500) })
        .onConflictDoNothing({ target: [recurringVerificationRuns.recurringId, recurringVerificationRuns.month] })
        .returning({ id: recurringVerificationRuns.id });
      return row?.id ?? null;
    },

    // Activation after a pause: the months that fell due meanwhile get a
    // `skipped` row so neither the job nor Kör nu creates them. ON CONFLICT
    // DO NOTHING — a month a concurrent Kör nu already created keeps its row.
    // Returns the months actually marked.
    async insertSkippedRunsInTx(tx: Tx, recurringId: string, months: string[]): Promise<string[]> {
      if (months.length === 0) return [];
      const rows = await tx
        .insert(recurringVerificationRuns)
        .values(months.map((month) => ({ recurringId, month, status: "skipped" as const })))
        .onConflictDoNothing({ target: [recurringVerificationRuns.recurringId, recurringVerificationRuns.month] })
        .returning({ month: recurringVerificationRuns.month });
      return rows.map((r) => r.month);
    },

    // Kör nu: the failed months are tried again — their rows go, the months
    // become due again. Skipped months stay skipped.
    async deleteFailedRuns(recurringId: string): Promise<number> {
      const rows = await db
        .delete(recurringVerificationRuns)
        .where(and(eq(recurringVerificationRuns.recurringId, recurringId), eq(recurringVerificationRuns.status, "failed")))
        .returning({ id: recurringVerificationRuns.id });
      return rows.length;
    },

    async findRunById(id: string): Promise<RecurringRunRow | null> {
      const [row] = await db
        .select({
          id: recurringVerificationRuns.id,
          recurringId: recurringVerificationRuns.recurringId,
          month: recurringVerificationRuns.month,
          status: recurringVerificationRuns.status,
          error: recurringVerificationRuns.error,
          verificationId: recurringVerificationRuns.verificationId,
          createdAt: recurringVerificationRuns.createdAt,
        })
        .from(recurringVerificationRuns)
        .where(eq(recurringVerificationRuns.id, id));
      return row ? { ...row, verificationDisplayNumber: null } : null;
    },
  };
}

export type RecurringVerificationRepository = ReturnType<typeof createRecurringVerificationRepository>;
