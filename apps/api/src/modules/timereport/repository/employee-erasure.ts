import { and, eq, isNotNull, sql } from "drizzle-orm";
import {
  absences,
  atfTransactions,
  attendanceSessions,
  auditLog,
  employees,
  payrollPeriods,
  timeReports,
  type Db,
  type Tx,
} from "@navet/db";

// Radera eller anonymisera en anställd (GDPR, #2; spec
// 2026-10-29-radera-anonymisera-anstalld-design.md). Leaf file, schema
// imports only, Db | Tx throughout: the facts are read again inside the
// write's own transaction, with the employee row locked, so a stamp or an
// unlocked period between the card's preview and the click cannot slip by.

export const ANONYMIZED_NAME = "Anonymiserad anställd";

// Every row that ties the employee to time, absence or pay — and the months
// it falls in (Stockholm days for the timestamped sessions; a session that
// crosses midnight counts in both months).
function historyMonthsSql(employeeId: string) {
  return sql`
    select distinct to_char(d, 'YYYY-MM') as month from (
      select date as d from time_reports where employee_id = ${employeeId}
      union all select date from absences where employee_id = ${employeeId}
      union all select date from atf_transactions where employee_id = ${employeeId}
      union all select date from overtime_dispositions where employee_id = ${employeeId}
      union all select (started_at at time zone 'Europe/Stockholm')::date from attendance_sessions where employee_id = ${employeeId}
      union all select (stopped_at at time zone 'Europe/Stockholm')::date from attendance_sessions where employee_id = ${employeeId} and stopped_at is not null
      union all select (started_at at time zone 'Europe/Stockholm')::date from stamp_sessions where employee_id = ${employeeId}
      union all select (stopped_at at time zone 'Europe/Stockholm')::date from stamp_sessions where employee_id = ${employeeId} and stopped_at is not null
      union all select make_date(p.year, p.month, 1) from payroll_attestations a join payroll_periods p on p.id = a.period_id where a.employee_id = ${employeeId}
    ) x
    order by 1`;
}

// A locked period's frozen basis that lists the employee.
function inFrozenSummarySql(employeeId: string) {
  return sql`exists (
    select 1 from payroll_periods
    where summary is not null and summary->'employees' @> jsonb_build_array(jsonb_build_object('employeeId', ${employeeId}::text))
  )`;
}

export interface ErasureFacts {
  // Any time, absence, ATF, overtime choice or attestation, or a frozen
  // payroll basis naming the employee — "has stamped or been paid".
  hasHistory: boolean;
  openSession: boolean;
  // Months with history whose payroll period is not locked, ascending.
  openMonths: string[];
}

export async function readErasureFacts(db: Db | Tx, employeeId: string): Promise<ErasureFacts> {
  const months = (await db.execute(historyMonthsSql(employeeId))) as unknown as { month: string }[];
  const [flags] = (await db.execute(sql`
    select
      ${inFrozenSummarySql(employeeId)} as in_summary,
      exists (select 1 from attendance_sessions where employee_id = ${employeeId} and stopped_at is null)
        or exists (select 1 from stamp_sessions where employee_id = ${employeeId} and stopped_at is null) as open_session`)) as unknown as {
    in_summary: boolean;
    open_session: boolean;
  }[];
  const locked = new Set<string>();
  if (months.length > 0) {
    const rows = await db
      .select({ year: payrollPeriods.year, month: payrollPeriods.month })
      .from(payrollPeriods)
      .where(eq(payrollPeriods.status, "locked"));
    for (const row of rows) locked.add(`${row.year}-${String(row.month).padStart(2, "0")}`);
  }
  return {
    hasHistory: months.length > 0 || flags!.in_summary,
    openSession: flags!.open_session,
    openMonths: months.map((m) => m.month).filter((month) => !locked.has(month)),
  };
}

// Locks the employee row for the erasure; null when it does not exist.
export async function lockEmployee(tx: Tx, employeeId: string) {
  const [row] = await tx.select().from(employees).where(eq(employees.id, employeeId)).for("update");
  return row ?? null;
}

// No history: the row goes. Schedule overrides and Förvalda stationer
// cascade; mo_reports/mo_operation_scrap keep the report without a name
// (ON DELETE SET NULL).
export async function deleteEmployeeInTx(tx: Tx, employeeId: string) {
  await tx.delete(employees).where(eq(employees.id, employeeId));
}

// Drops every free-text key (note, startNote, stopNote) wherever it sits in
// an audit entry's detail — top level or inside before/after.
const FREE_TEXT_KEYS = new Set(["note", "startNote", "stopNote"]);
export function withoutFreeText(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutFreeText);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !FREE_TEXT_KEYS.has(key))
      .map(([key, inner]) => [key, withoutFreeText(inner)])
  );
}

// With history: the personal data goes, the history stays under the kept
// employee number. The employees UPDATE comes first — after it the guard
// triggers (migration 0170) refuse new rows for the employee, and only the
// notes below are still written (UPDATEs, which the triggers allow).
export async function anonymizeEmployeeInTx(tx: Tx, employeeId: string) {
  await tx
    .update(employees)
    .set({
      name: ANONYMIZED_NAME,
      active: false,
      phone: null,
      email: null,
      address: null,
      postalCode: null,
      city: null,
      personalIdentityNumber: null,
      employedFrom: null,
      employedTo: null,
      wage: null,
      weeklyHours: null,
      defaultWeekScheduleId: null,
      atfMinutesPerWeek: null,
      atfStartDate: null,
      anonymizedAt: sql`now()`,
    })
    .where(eq(employees.id, employeeId));

  // Free text — the reasons given at the terminal can be health data, and
  // none of it is part of the payroll basis.
  await tx.update(attendanceSessions).set({ startNote: null, stopNote: null }).where(eq(attendanceSessions.employeeId, employeeId));
  await tx.update(timeReports).set({ note: null }).where(and(eq(timeReports.employeeId, employeeId), isNotNull(timeReports.note)));
  await tx.update(absences).set({ note: null }).where(and(eq(absences.employeeId, employeeId), isNotNull(absences.note)));
  await tx.update(atfTransactions).set({ note: null }).where(and(eq(atfTransactions.employeeId, employeeId), isNotNull(atfTransactions.note)));

  // The frozen payroll bases keep the number, not the name.
  await tx.execute(sql`
    update payroll_periods set summary = jsonb_set(summary, '{employees}', (
      select jsonb_agg(
        case when e->>'employeeId' = ${employeeId}::text then jsonb_set(e, '{name}', to_jsonb(${ANONYMIZED_NAME}::text)) else e end
        order by ord)
      from jsonb_array_elements(summary->'employees') with ordinality as t(e, ord)))
    where summary is not null and summary->'employees' @> jsonb_build_array(jsonb_build_object('employeeId', ${employeeId}::text))`);

  // The audit trail keeps what happened, not what was written in free text.
  const entries = await tx
    .select({ id: auditLog.id, detail: auditLog.detail })
    .from(auditLog)
    .where(sql`${auditLog.detail}->>'employeeId' = ${employeeId}`);
  const changed = entries.filter((entry) => JSON.stringify(withoutFreeText(entry.detail)) !== JSON.stringify(entry.detail));
  for (const entry of changed) {
    await tx.update(auditLog).set({ detail: withoutFreeText(entry.detail) }).where(eq(auditLog.id, entry.id));
  }
  return { auditEntriesScrubbed: changed.length };
}
