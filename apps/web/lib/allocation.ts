// Fördela över perioder: the monthly amounts of an allocation, mirroring the
// server (recurring-schedule.ts allocationAmounts) byte for byte: the amount
// is first rounded to öre with the server's round2, then amount / months
// rounded DOWN to öre, and the LAST month takes the remainder so the parts
// always add up to the amount (never a negative last month). No imports —
// pure, like splitVat.ts — so round2 is copied from @navet/shared's money.ts
// (manual-bookkeeping-web.shared.test.ts pins the two to the same output).
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function allocationAmounts(amount: number, months: number): number[] {
  if (!Number.isFinite(amount) || !Number.isInteger(months) || months < 1) return [];
  const cents = Math.round(round2(amount) * 100);
  const part = Math.floor(cents / months);
  if (part < 1) return [];
  const amounts: number[] = [];
  for (let i = 0; i < months - 1; i++) amounts.push(part / 100);
  amounts.push((cents - part * (months - 1)) / 100);
  return amounts.map(round2);
}

// "2026-11" + n months → "YYYY-MM" list starting at the first month.
export function allocationMonths(firstMonth: string, months: number): string[] {
  const match = /^(\d{4})-(\d{2})$/.exec(firstMonth);
  if (!match || !Number.isInteger(months) || months < 1) return [];
  let year = Number(match[1]);
  let month = Number(match[2]);
  const list: string[] = [];
  for (let i = 0; i < months; i++) {
    list.push(`${year}-${String(month).padStart(2, "0")}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return list;
}
