// Fördela över perioder: the monthly amounts of an allocation, mirroring the
// server (recurring allocation): amount / months rounded to öre, the LAST
// month takes the remainder so the parts always add up to the amount. No
// imports — pure, like splitVat.ts.
export function allocationAmounts(amount: number, months: number): number[] {
  if (!Number.isFinite(amount) || !Number.isInteger(months) || months < 1) return [];
  const cents = Math.round(amount * 100);
  const part = Math.round(cents / months);
  const amounts: number[] = [];
  for (let i = 0; i < months - 1; i++) amounts.push(part / 100);
  amounts.push((cents - part * (months - 1)) / 100);
  return amounts;
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
