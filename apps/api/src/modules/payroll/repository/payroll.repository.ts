import { and, asc, desc, eq, getTableColumns, gte, lte, sql } from "drizzle-orm";
import {
  absences,
  absenceTypes,
  attendanceDeviationReasons,
  auditLog,
  obRules,
  overtimeDispositions,
  payrollAttestations,
  payrollPeriods,
  users,
  type Db,
  type Tx,
} from "@navet/db";
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

// Postgres `time` columns come back as "HH:MM:SS" — the API speaks "HH:MM".
const hhmm = (t: string) => t.slice(0, 5);

function mapObRule(row: typeof obRules.$inferSelect) {
  return { ...row, startTime: hhmm(row.startTime), endTime: hhmm(row.endTime) };
}

// The day's overtime choice (Övertid ersätts som), one row per employee and
// day. Db | Tx so the terminal's Gå hem writes it in the transaction that
// closes the attendance (OvertimeDispositionWriter in timereport.service.ts).
export async function upsertOvertimeDispositionInTx(
  dbc: Db | Tx,
  employeeId: string,
  date: string,
  disposition: OvertimeDisposition,
  createdBy: string
) {
  const [row] = await dbc
    .insert(overtimeDispositions)
    .values({ employeeId, date, disposition, createdBy })
    .onConflictDoUpdate({
      target: [overtimeDispositions.employeeId, overtimeDispositions.date],
      set: { disposition, createdBy },
    })
    .returning();
  return row!;
}

// The absence-type/OB-rule tables carry extra columns beyond the base-data
// registers' code+name shape, so this writes explicit CRUD for each rather
// than reusing register.repository.ts's `forTable` generic.
export function createPayrollRepository(db: Db) {
  return {
    // --- Frånvarokoder ---

    async listAbsenceTypes(includeInactive = false) {
      return db
        .select()
        .from(absenceTypes)
        .where(includeInactive ? undefined : eq(absenceTypes.active, true))
        .orderBy(asc(absenceTypes.code));
    },

    async findAbsenceTypeById(id: string) {
      const [row] = await db.select().from(absenceTypes).where(eq(absenceTypes.id, id));
      return row ?? null;
    },

    async findAbsenceTypeByCode(code: string) {
      const [row] = await db.select().from(absenceTypes).where(eq(absenceTypes.code, code));
      return row ?? null;
    },

    async findAbsenceTypeByName(name: string) {
      const [row] = await db.select().from(absenceTypes).where(eq(absenceTypes.name, name));
      return row ?? null;
    },

    async createAbsenceType(input: CreateAbsenceTypeInput) {
      const [row] = await db.insert(absenceTypes).values(input).returning();
      return row!;
    },

    async updateAbsenceType(id: string, input: UpdateAbsenceTypeInput) {
      const [row] = await db.update(absenceTypes).set(input).where(eq(absenceTypes.id, id)).returning();
      return row ?? null;
    },

    // Seed helper: inserts the entry unless its code or name already exists
    // (any conflict skips — existing entries are never touched). Returns
    // true when a row was actually created.
    async createAbsenceTypeIfMissing(input: { code: string; name: string; paxmlCode: string; earnsAtf: boolean }) {
      const rows = await db.insert(absenceTypes).values(input).onConflictDoNothing().returning();
      return rows.length > 0;
    },

    // --- Avvikelseorsaker ---

    async listAttendanceDeviationReasons(includeInactive = false) {
      return db
        .select()
        .from(attendanceDeviationReasons)
        .where(includeInactive ? undefined : eq(attendanceDeviationReasons.active, true))
        .orderBy(asc(attendanceDeviationReasons.code));
    },

    async findAttendanceDeviationReasonByCode(code: string) {
      const [row] = await db.select().from(attendanceDeviationReasons).where(eq(attendanceDeviationReasons.code, code));
      return row ?? null;
    },

    async findAttendanceDeviationReasonByName(name: string) {
      const [row] = await db.select().from(attendanceDeviationReasons).where(eq(attendanceDeviationReasons.name, name));
      return row ?? null;
    },

    async createAttendanceDeviationReason(input: CreateAttendanceDeviationReasonInput) {
      const [row] = await db.insert(attendanceDeviationReasons).values(input).returning();
      return row!;
    },

    async updateAttendanceDeviationReason(id: string, input: UpdateAttendanceDeviationReasonInput) {
      const [row] = await db
        .update(attendanceDeviationReasons)
        .set(input)
        .where(eq(attendanceDeviationReasons.id, id))
        .returning();
      return row ?? null;
    },

    // --- OB-regler ---

    async listObRules(includeInactive = false) {
      const rows = await db
        .select()
        .from(obRules)
        .where(includeInactive ? undefined : eq(obRules.active, true))
        .orderBy(asc(obRules.code));
      return rows.map(mapObRule);
    },

    async findObRuleById(id: string) {
      const [row] = await db.select().from(obRules).where(eq(obRules.id, id));
      return row ? mapObRule(row) : null;
    },

    async findObRuleByCode(code: string) {
      const [row] = await db.select().from(obRules).where(eq(obRules.code, code));
      return row ? mapObRule(row) : null;
    },

    async findObRuleByName(name: string) {
      const [row] = await db.select().from(obRules).where(eq(obRules.name, name));
      return row ? mapObRule(row) : null;
    },

    async createObRule(input: CreateObRuleInput) {
      const [row] = await db.insert(obRules).values(input).returning();
      return mapObRule(row!);
    },

    async updateObRule(id: string, input: UpdateObRuleInput) {
      const [row] = await db.update(obRules).set(input).where(eq(obRules.id, id)).returning();
      return row ? mapObRule(row) : null;
    },

    // --- Frånvaro (absence bookings) ---

    async listEmployeeAbsences(employeeId: string, from?: string, to?: string) {
      const conditions = [eq(absences.employeeId, employeeId)];
      if (from) conditions.push(gte(absences.date, from));
      if (to) conditions.push(lte(absences.date, to));

      return db
        .select({
          ...getTableColumns(absences),
          absenceTypeCode: absenceTypes.code,
          absenceTypeName: absenceTypes.name,
          // paxmlCode isn't shown anywhere absences are currently listed, but
          // the period summary's per-type aggregate needs it alongside the
          // code/name already selected here.
          absenceTypePaxmlCode: absenceTypes.paxmlCode,
        })
        .from(absences)
        .innerJoin(absenceTypes, eq(absenceTypes.id, absences.absenceTypeId))
        .where(and(...conditions))
        .orderBy(desc(absences.date));
    },

    // Utjämning: per day, the minutes of absence whose kind earns no ATF
    // (sjuk/VAB/…) — the schedule resolver lengthens the week's last workday
    // by the ATF share they lose (AtfAbsenceReader in schedule.service.ts).
    async listNonEarningAbsences(employeeId: string, from: string, to: string) {
      return db
        .select({ date: absences.date, minutes: sql<number>`sum(${absences.minutes})::int` })
        .from(absences)
        .innerJoin(absenceTypes, eq(absenceTypes.id, absences.absenceTypeId))
        .where(
          and(
            eq(absences.employeeId, employeeId),
            eq(absenceTypes.earnsAtf, false),
            gte(absences.date, from),
            lte(absences.date, to)
          )
        )
        .groupBy(absences.date);
    },

    async findAbsenceById(id: string) {
      const [row] = await db.select().from(absences).where(eq(absences.id, id));
      return row ?? null;
    },

    async createAbsence(employeeId: string, input: CreateAbsenceInput, createdBy: string) {
      const [row] = await db
        .insert(absences)
        .values({
          employeeId,
          absenceTypeId: input.absenceTypeId,
          date: input.date,
          minutes: input.minutes,
          note: input.note,
          createdBy,
        })
        .returning();
      return row!;
    },

    async deleteAbsence(id: string) {
      const [row] = await db.delete(absences).where(eq(absences.id, id)).returning();
      return row ?? null;
    },

    // --- Övertidsdispositioner (per-dag-avvikelse från personalkortets default) ---

    async listEmployeeOvertimeDispositions(employeeId: string, from: string, to: string) {
      return db
        .select()
        .from(overtimeDispositions)
        .where(
          and(
            eq(overtimeDispositions.employeeId, employeeId),
            gte(overtimeDispositions.date, from),
            lte(overtimeDispositions.date, to)
          )
        );
    },

    async upsertOvertimeDisposition(
      employeeId: string,
      date: string,
      disposition: OvertimeDisposition,
      createdBy: string
    ) {
      return upsertOvertimeDispositionInTx(db, employeeId, date, disposition, createdBy);
    },

    async deleteOvertimeDisposition(employeeId: string, date: string) {
      const [row] = await db
        .delete(overtimeDispositions)
        .where(and(eq(overtimeDispositions.employeeId, employeeId), eq(overtimeDispositions.date, date)))
        .returning();
      return row ?? null;
    },

    // --- Löneperioder (period summary/lock) ---

    async findPayrollPeriod(year: number, month: number) {
      const [row] = await db
        .select()
        .from(payrollPeriods)
        .where(and(eq(payrollPeriods.year, year), eq(payrollPeriods.month, month)));
      return row ?? null;
    },

    // Status-only read for the period-lock guard — no row means the period
    // has never been touched, which is the same thing as open.
    async getPeriodStatus(year: number, month: number): Promise<"open" | "locked" | null> {
      const [row] = await db
        .select({ status: payrollPeriods.status })
        .from(payrollPeriods)
        .where(and(eq(payrollPeriods.year, year), eq(payrollPeriods.month, month)));
      return row?.status ?? null;
    },

    // Period rows are created lazily — the first attestation or lock of a
    // month materializes the row. onConflictDoNothing + re-select rather than
    // an upsert so a concurrent creator's row (and its status) wins instead of
    // being reset to open.
    async ensurePayrollPeriod(year: number, month: number) {
      const [inserted] = await db
        .insert(payrollPeriods)
        .values({ year, month })
        .onConflictDoNothing({ target: [payrollPeriods.year, payrollPeriods.month] })
        .returning();
      if (inserted) return inserted;
      const [existing] = await db
        .select()
        .from(payrollPeriods)
        .where(and(eq(payrollPeriods.year, year), eq(payrollPeriods.month, month)));
      return existing!;
    },

    // --- Attestering ---

    async createAttestation(periodId: string, employeeId: string, attestedBy: string) {
      const [row] = await db.insert(payrollAttestations).values({ periodId, employeeId, attestedBy }).returning();
      return row!;
    },

    async deleteAttestation(periodId: string, employeeId: string) {
      const [row] = await db
        .delete(payrollAttestations)
        .where(and(eq(payrollAttestations.periodId, periodId), eq(payrollAttestations.employeeId, employeeId)))
        .returning();
      return row ?? null;
    },

    // Låsning: freezes the period and stores the computed basis verbatim.
    // `summary` is plain JSON (a PeriodSummary) — this repository is its only
    // writer, which is what lets the read path cast it back unchecked.
    async lockPayrollPeriod(periodId: string, summary: unknown, lockedAt: Date, lockedBy: string) {
      const [row] = await db
        .update(payrollPeriods)
        .set({ status: "locked", summary, lockedAt, lockedBy })
        .where(eq(payrollPeriods.id, periodId))
        .returning();
      return row ?? null;
    },

    // Upplåsning: back to open and the snapshot is dropped from the period,
    // so the summary is computed live again (attestations are deliberately
    // kept). The dropped basis — what was locked and could have been
    // exported — is kept in the unlock's audit entry (`detail.snapshot`, with
    // when and by whom it was locked), written in the SAME transaction so a
    // basis never disappears without a trace. Conditional on the locked
    // status under FOR UPDATE: a concurrent unlock gets null.
    async unlockPayrollPeriod(periodId: string, entry: { entityId: string; userId: string }) {
      return db.transaction(async (tx) => {
        const [old] = await tx
          .select()
          .from(payrollPeriods)
          .where(and(eq(payrollPeriods.id, periodId), eq(payrollPeriods.status, "locked")))
          .for("update");
        if (!old) return null;
        await tx
          .update(payrollPeriods)
          .set({ status: "open", summary: null, lockedAt: null, lockedBy: null })
          .where(eq(payrollPeriods.id, periodId));
        const employees = (old.summary as { employees?: unknown } | null)?.employees;
        await tx.insert(auditLog).values({
          entityType: "payroll_period",
          entityId: entry.entityId,
          action: "unlocked",
          detail: {
            year: old.year,
            month: old.month,
            lockedAt: old.lockedAt?.toISOString() ?? null,
            lockedBy: old.lockedBy,
            employeeCount: Array.isArray(employees) ? employees.length : 0,
            snapshot: old.summary ?? null,
          },
          userId: entry.userId,
        });
        return old;
      });
    },

    // Tidigare låsta underlag: the period's unlock entries that kept their
    // basis (older unlocks, before the basis was saved, have none), newest
    // first, without the snapshot itself.
    async listUnlockedSnapshots(entityId: string) {
      const lockedByUser = sql<string | null>`(select ${users.name} from ${users} where ${users.id}::text = ${auditLog.detail}->>'lockedBy')`;
      const rows = await db
        .select({
          id: auditLog.id,
          unlockedAt: auditLog.createdAt,
          unlockedByName: users.name,
          lockedAt: sql<string | null>`${auditLog.detail}->>'lockedAt'`,
          lockedByName: lockedByUser,
          employeeCount: sql<number>`coalesce((${auditLog.detail}->>'employeeCount')::int, 0)`,
        })
        .from(auditLog)
        .leftJoin(users, eq(users.id, auditLog.userId))
        .where(and(unlockedSnapshotWhere(entityId)))
        .orderBy(desc(auditLog.createdAt), desc(auditLog.id));
      return rows;
    },

    // One kept basis, null when the entry is not this period's unlock with a
    // saved snapshot.
    async findUnlockedSnapshot(entityId: string, auditId: string): Promise<unknown | null> {
      const [row] = await db
        .select({ snapshot: sql<unknown>`${auditLog.detail}->'snapshot'` })
        .from(auditLog)
        .where(and(eq(auditLog.id, auditId), unlockedSnapshotWhere(entityId)));
      return row?.snapshot ?? null;
    },

    // Per-employee attestation rows for one period, joined with the
    // attesting user's name (null when the user account was later removed).
    async listAttestationsForPeriod(periodId: string) {
      return db
        .select({
          employeeId: payrollAttestations.employeeId,
          attestedAt: payrollAttestations.attestedAt,
          attestedByName: users.name,
        })
        .from(payrollAttestations)
        .leftJoin(users, eq(users.id, payrollAttestations.attestedBy))
        .where(eq(payrollAttestations.periodId, periodId));
    },
  };
}

export type PayrollRepository = ReturnType<typeof createPayrollRepository>;

// An unlock entry of the period that kept its basis as an object.
function unlockedSnapshotWhere(entityId: string) {
  return and(
    eq(auditLog.entityType, "payroll_period"),
    eq(auditLog.entityId, entityId),
    eq(auditLog.action, "unlocked"),
    sql`jsonb_typeof(${auditLog.detail}->'snapshot') = 'object'`
  );
}
