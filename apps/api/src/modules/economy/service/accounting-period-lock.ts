// Period-lock guard for bookkeeping: booking a verification whose date falls
// in a locked accounting period is rejected. Leaf file (no imports from the
// economy services) so future modules (B2 auto-posting) can consume it
// without cycles — same trick as payroll's period-lock.ts.
//
// Difference from payroll: a date with NO period at all is NOT "open" — it
// means no fiscal year covers the date, which is its own error at booking
// time (checked separately by the booking service, not by this guard).

export class AccountingPeriodLockedError extends Error {
  constructor(date: string) {
    super(`Accounting period for ${date} is locked`);
    this.name = "AccountingPeriodLockedError";
  }
}

// Årsbokslut: the date's fiscal year is closed. A SUBCLASS of the period
// lock on purpose — every existing `instanceof AccountingPeriodLockedError`
// mapping (409) keeps working, while the code says what actually happened.
export class FiscalYearClosedError extends AccountingPeriodLockedError {
  constructor(what: string) {
    super(what);
    this.message = `The fiscal year (${what}) is closed — reopen it under Bokslut`;
    this.name = "FiscalYearClosedError";
  }
}

export interface AccountingPeriodLockChecker {
  isDateLocked(date: string): Promise<boolean>;
}

export function createAccountingPeriodLockChecker(repo: {
  getPeriodStatusForDate(date: string): Promise<"open" | "locked" | null>;
}): AccountingPeriodLockChecker {
  return {
    async isDateLocked(date) {
      return (await repo.getPeriodStatusForDate(date)) === "locked";
    },
  };
}
