// Fakturaskanning — reading dates and amounts the way Swedish and English
// invoices print them (spec §3.3 punkt 4–5). Pure.

const MONTHS: Record<string, number> = {
  januari: 1, january: 1, jan: 1,
  februari: 2, february: 2, feb: 2,
  mars: 3, march: 3, mar: 3,
  april: 4, apr: 4,
  maj: 5, may: 5,
  juni: 6, june: 6, jun: 6,
  juli: 7, july: 7, jul: 7,
  augusti: 8, august: 8, aug: 8,
  september: 9, sept: 9, sep: 9,
  oktober: 10, october: 10, okt: 10, oct: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
};

function isoIfValid(y: number, m: number, d: number): string | null {
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export interface FoundValue<T> {
  value: T;
  // Where in the searched text the value starts and ends.
  index: number;
  end: number;
}

// Every date in the text, in order: YYYY-MM-DD, YYYYMMDD, DD.MM.YYYY,
// DD/MM/YYYY, DD-MM-YYYY and "D mån YYYY" (Swedish or English month names,
// abbreviations with or without a dot).
export function findDates(text: string): FoundValue<string>[] {
  const found: FoundValue<string>[] = [];
  const push = (iso: string | null, index: number, length: number) => {
    if (iso && !found.some((f) => index < f.end && f.index < index + length)) found.push({ value: iso, index, end: index + length });
  };
  for (const m of text.matchAll(/(?<!\d)(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)/g)) push(isoIfValid(+m[1]!, +m[2]!, +m[3]!), m.index!, m[0].length);
  for (const m of text.matchAll(/(?<![\d.\/-])(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?![\d.\/-])/g)) push(isoIfValid(+m[3]!, +m[2]!, +m[1]!), m.index!, m[0].length);
  for (const m of text.matchAll(/(?<!\d)(\d{4})(\d{2})(\d{2})(?!\d)/g)) push(isoIfValid(+m[1]!, +m[2]!, +m[3]!), m.index!, m[0].length);
  for (const m of text.matchAll(/(?<![\p{L}\d])(\d{1,2})\.?\s+(\p{L}{3,9})\.?\s+(\d{4})(?!\d)/gu)) {
    const month = MONTHS[m[2]!.toLowerCase()];
    if (month) push(isoIfValid(+m[3]!, month, +m[1]!), m.index!, m[0].length);
  }
  return found.sort((a, b) => a.index - b.index);
}

export function parseDate(text: string): string | null {
  return findDates(text)[0]?.value ?? null;
}

// An amount as invoices print it: 1 234,50 · 1.234,50 · 1,234.50 · 1234.50
// · 1234,50 · −1 234,50 · 1 234,50- — two decimals required (an integer
// is a quantity or a number far more often than an amount). Never part of a
// date (30.11.2026) or a percentage (25,00 %). A minus sign counts only
// directly against the number (or right after it): "Att betala – 1 234,50"
// is a label, a dash and a positive amount.
const AMOUNT_RE =
  /(?<![\d.,])([-−–])?(\d{1,3}(?:[   .,']\d{3})+|\d+)([.,])(\d{2})(?![\d.,])(-(?![\d]))?(?!\s?%)/g;

export function findAmounts(text: string): FoundValue<number>[] {
  const found: FoundValue<number>[] = [];
  for (const m of text.matchAll(AMOUNT_RE)) {
    const integerPart = m[2]!;
    const decimalSep = m[3]!;
    // A thousands separator equal to the decimal separator is not an amount
    // ("1.234.50").
    const groupSeps = integerPart.replace(/\d/g, "");
    if (groupSeps.includes(decimalSep)) continue;
    if (new Set(groupSeps).size > 1) continue;
    const value = Number(`${integerPart.replace(/\D/g, "")}.${m[4]!}`);
    if (!Number.isFinite(value)) continue;
    const negative = m[1] !== undefined || m[5] !== undefined;
    found.push({ value: negative ? -value : value, index: m.index!, end: m.index! + m[0].length });
  }
  return found;
}

// The LAST amount in the text — on a summary line ("Moms 25 %  250,00") the
// amount stands after any rate or base.
export function parseLastAmount(text: string): number | null {
  const all = findAmounts(text);
  return all.length > 0 ? all[all.length - 1]!.value : null;
}

const DAY_MS = 86_400_000;

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

// Rimlighet: an invoice date within ±400 days of today.
export function plausibleInvoiceDate(date: string, today: string): boolean {
  return Math.abs(daysBetween(today, date)) <= 400;
}

// Rimlighet: a due date on or after the invoice date and at most 180 days
// after it.
export function plausibleDueDate(dueDate: string, invoiceDate: string | null): boolean {
  if (invoiceDate === null) return true;
  const days = daysBetween(invoiceDate, dueDate);
  return days >= 0 && days <= 180;
}

// sv-SE "1 234,50" with a plain hyphen for checks texts.
export function formatAmountSv(value: number): string {
  return value.toLocaleString("sv-SE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace("−", "-");
}

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
