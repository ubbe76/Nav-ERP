// Calendar half-years — the periods Riksbankens referensränta is set for
// (räntelagen 9 §: 1 January and 1 July). Pure, no DB imports; shared by
// the referensränta fetch (exchange-rates.ts) and the dröjsmålsränta
// (sales/service/late-interest.ts) so both split a period the same way.

// The half-year a day belongs to: 1 January or 1 July of its year.
export function halfYearStart(date: string): string {
  const year = date.slice(0, 4);
  return Number(date.slice(5, 7)) < 7 ? `${year}-01-01` : `${year}-07-01`;
}

// The start of the half-year after the one `date` is in.
export function nextHalfYearStart(date: string): string {
  const start = halfYearStart(date);
  return start.endsWith("-01-01") ? `${start.slice(0, 4)}-07-01` : `${Number(start.slice(0, 4)) + 1}-01-01`;
}

// The start of the half-year before the one `date` is in.
export function previousHalfYearStart(date: string): string {
  const start = halfYearStart(date);
  return start.endsWith("-07-01") ? `${start.slice(0, 4)}-01-01` : `${Number(start.slice(0, 4)) - 1}-07-01`;
}

// Every half-year start whose half-year touches [from, to] (inclusive).
export function halfYearStartsBetween(from: string, to: string): string[] {
  if (from > to) return [];
  const starts: string[] = [];
  for (let start = halfYearStart(from); start <= to; start = nextHalfYearStart(start)) starts.push(start);
  return starts;
}
