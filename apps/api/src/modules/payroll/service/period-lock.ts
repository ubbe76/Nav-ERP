// Period-lock guard: writes that feed the payroll basis (absences, time
// reports, ATF transactions, schedule overrides, holidays) are rejected once
// the calendar-month period covering their date has been locked (attested).
//
// Leaf file on purpose — the timereport module's services import the error
// and the interface from here, so it must never import anything from them
// (no cycle). The checker only needs a period-status reader, which the
// payroll repository satisfies structurally.

export class PayrollPeriodLockedError extends Error {
  constructor(date: string) {
    super(`Payroll period for ${date} is locked`);
    this.name = "PayrollPeriodLockedError";
  }
}

export interface PeriodLockChecker {
  isDateLocked(date: string): Promise<boolean>;
}

// A date belongs to exactly one calendar-month period; a period with no row
// at all has never been touched and is therefore open.
export function createPeriodLockChecker(repo: {
  getPeriodStatus(year: number, month: number): Promise<"open" | "locked" | null>;
}): PeriodLockChecker {
  return {
    async isDateLocked(date) {
      const year = Number(date.slice(0, 4));
      const month = Number(date.slice(5, 7));
      return (await repo.getPeriodStatus(year, month)) === "locked";
    },
  };
}
