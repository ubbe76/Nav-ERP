// Pure calendar-month period generation for fiscal years. Leaf-like file (no
// DB access, no imports from economy.repository.ts or economy.service.ts) so
// it can be imported from the repository layer without inverting the usual
// service→repository dependency direction — same reasoning that keeps
// accounting-period-lock.ts import-free.

export interface MonthlyPeriodBounds {
  startDate: string;
  endDate: string;
}

function parseDateOnly(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!));
}

function formatDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// Walks calendar months from the fiscal year's startDate through its
// endDate; the first and last period are clipped to the year's own bounds —
// a brutet år like 2026-05-01–2027-04-30 still yields exactly 12 periods
// (first 2026-05-01–2026-05-31, last 2027-04-01–2027-04-30), a short year
// like 2026-07-01–2026-12-31 yields 6, and a year that doesn't start/end on
// a month boundary (e.g. 2026-05-15–2027-05-14) clips both ends to the
// actual start/end dates.
export function generateMonthlyPeriods(startDate: string, endDate: string): MonthlyPeriodBounds[] {
  const yearStart = parseDateOnly(startDate);
  const yearEnd = parseDateOnly(endDate);

  const periods: MonthlyPeriodBounds[] = [];
  let cursor = new Date(Date.UTC(yearStart.getUTCFullYear(), yearStart.getUTCMonth(), 1));

  while (cursor <= yearEnd) {
    const monthEnd = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0));
    const periodStart = cursor < yearStart ? yearStart : cursor;
    const periodEnd = monthEnd > yearEnd ? yearEnd : monthEnd;
    periods.push({ startDate: formatDateOnly(periodStart), endDate: formatDateOnly(periodEnd) });
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
  }

  return periods;
}
