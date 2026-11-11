// Pure (no imports): shared by the schedule service and the schedule
// repository's payroll-period guard.

const addDaysUTC = (date: Date, days: number) => new Date(date.getTime() + days * 86_400_000);
const toDateString = (date: Date) => date.toISOString().slice(0, 10);

// Inverse of isoWeekOf: the Monday and Sunday bounding an ISO week. Jan 4 is
// by definition in ISO week 1, so week 1's Monday is the Monday on or before
// it. Used by the period-lock guard — a week override may straddle two
// calendar months, and both have to be checked.
export function isoWeekRange(isoYear: number, isoWeek: number): { monday: string; sunday: string } {
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const week1Monday = addDaysUTC(jan4, -((jan4.getUTCDay() || 7) - 1));
  const monday = addDaysUTC(week1Monday, (isoWeek - 1) * 7);
  return { monday: toDateString(monday), sunday: toDateString(addDaysUTC(monday, 6)) };
}
