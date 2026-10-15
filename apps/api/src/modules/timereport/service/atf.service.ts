import type { CreateAtfTransactionInput } from "@navet/shared";
import type { AtfRepository } from "../repository/atf.repository.js";
import { EmployeeNotFoundError } from "./timereport.service.js";
// Leaf file in the payroll module — no import cycle (see period-lock.ts).
import { PayrollPeriodLockedError, type PeriodLockChecker } from "../../payroll/service/period-lock.js";

export class AtfTransactionNotFoundError extends Error {
  constructor(id: string) {
    super(`ATF transaction ${id} not found`);
    this.name = "AtfTransactionNotFoundError";
  }
}

const DAY_MS = 86_400_000;
const parseDate = (date: string) => new Date(`${date}T00:00:00Z`);

// Monday on/after and on/before a date (ISO weekday 1).
function nextMondayOnOrAfter(date: Date): Date {
  const weekday = date.getUTCDay() || 7;
  return new Date(date.getTime() + ((8 - weekday) % 7) * DAY_MS);
}
function mondayOnOrBefore(date: Date): Date {
  const weekday = date.getUTCDay() || 7;
  return new Date(date.getTime() - (weekday - 1) * DAY_MS);
}

// Completed ATF weeks: whole Mon–Sun weeks with Monday ≥ startDate and
// Sunday < asOf. The week containing a mid-week start never counts (no
// pro-rata), and the current week counts first when its Sunday has passed.
export function completedAtfWeeks(startDate: string, asOf: string): number {
  const firstMonday = nextMondayOnOrAfter(parseDate(startDate));
  // Latest Monday whose Sunday lies strictly before asOf.
  const lastMonday = mondayOnOrBefore(new Date(parseDate(asOf).getTime() - 7 * DAY_MS));
  if (lastMonday < firstMonday) return 0;
  return Math.floor((lastMonday.getTime() - firstMonday.getTime()) / (7 * DAY_MS)) + 1;
}

// The employee register lives in the timereport service; ATF only reads it.
export interface AtfEmployeeReader {
  findEmployeeById(id: string): Promise<{
    id: string;
    atfMode: "bank" | "weekly";
    atfMinutesPerWeek: number | null;
    atfStartDate: string | null;
  } | null>;
}

// Injected like CostingSettingsReader in costing.service.ts — the system
// service satisfies this.
export interface AtfSettingsReader {
  getSettings(): Promise<{ atfMinutesPerWeek: number }>;
}

// Today in the server's local timezone as YYYY-MM-DD (sv-SE formats ISO-style).
const localToday = () => new Date().toLocaleDateString("sv-SE");

export function createAtfService(
  repo: AtfRepository,
  employees: AtfEmployeeReader,
  settings: AtfSettingsReader,
  periodLocks: PeriodLockChecker
) {
  async function requireEmployee(employeeId: string) {
    const employee = await employees.findEmployeeById(employeeId);
    if (!employee) throw new EmployeeNotFoundError(employeeId);
    return employee;
  }

  return {
    // ATF status: derived accrual (rule × completed weeks) + stored
    // adjustments − stored withdrawals. In weekly mode (veckouttag) accrual
    // is taken out continuously via the shorter schedule, so it never
    // reaches the balance.
    async getAtfStatus(employeeId: string, asOf = localToday()) {
      const employee = await requireEmployee(employeeId);
      const [{ atfMinutesPerWeek: systemMinutes }, sums, transactions] = await Promise.all([
        settings.getSettings(),
        repo.sumAtfTransactions(employeeId),
        repo.listAtfTransactions(employeeId),
      ]);

      const effectiveMinutesPerWeek = employee.atfMinutesPerWeek ?? systemMinutes;
      const accruedMinutes =
        employee.atfMode === "bank" && employee.atfStartDate
          ? completedAtfWeeks(employee.atfStartDate, asOf) * effectiveMinutesPerWeek
          : 0;

      return {
        mode: employee.atfMode,
        effectiveMinutesPerWeek,
        source: employee.atfMinutesPerWeek !== null ? ("employee" as const) : ("system" as const),
        startDate: employee.atfStartDate,
        accruedMinutes,
        withdrawnMinutes: sums.withdrawnMinutes,
        adjustedMinutes: sums.adjustedMinutes,
        balanceMinutes: accruedMinutes + sums.adjustedMinutes - sums.withdrawnMinutes,
        transactions,
      };
    },

    // ATF withdrawals feed the payroll basis for their date, so both writes
    // are blocked once that date's period is locked.
    async createAtfTransaction(employeeId: string, input: CreateAtfTransactionInput, createdBy: string) {
      await requireEmployee(employeeId);
      if (await periodLocks.isDateLocked(input.date)) throw new PayrollPeriodLockedError(input.date);
      return repo.createAtfTransaction(employeeId, input, createdBy);
    },

    async deleteAtfTransaction(employeeId: string, transactionId: string) {
      await requireEmployee(employeeId);
      const existing = await repo.findAtfTransaction(employeeId, transactionId);
      if (!existing) throw new AtfTransactionNotFoundError(transactionId);
      if (await periodLocks.isDateLocked(existing.date)) throw new PayrollPeriodLockedError(existing.date);

      const row = await repo.deleteAtfTransaction(employeeId, transactionId);
      if (!row) throw new AtfTransactionNotFoundError(transactionId);
    },
  };
}

export type AtfService = ReturnType<typeof createAtfService>;
