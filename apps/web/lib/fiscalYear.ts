// The fiscal year covering `today`, else the newest. fiscalYears arrive
// newest-first, so [0] alone can be a pre-registered FUTURE year and a report
// defaulting to it would open empty. Same idiom as the huvudbok page.
export function currentFiscalYear<T extends { startDate: string; endDate: string }>(
  fiscalYears: T[],
  today: string
): T | undefined {
  return fiscalYears.find((year) => year.startDate <= today && today <= year.endDate) ?? fiscalYears[0];
}
