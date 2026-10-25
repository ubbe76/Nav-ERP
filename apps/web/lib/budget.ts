// Budget (bokföringsgranskningen etapp 5 del B): the pure rules of the budget
// grid. No imports — like allocation.ts and splitVat.ts — so vitest loads it
// directly (apps/api/test/web-budget.test.ts) and the page components share
// ONE implementation of the distribution, the sign rule and the row maths.

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// Fördela årsbelopp jämnt: whole kronor per month, rounded DOWN (towards zero
// for a negative amount, i.e. symmetric), and the LAST month takes the rest so
// the months always add up to the annual amount (öre included). 1 000 over 12
// months → 83 × 11 and 87. Returns [] for an unusable input.
export function distributeAnnual(total: number, months: number): number[] {
  if (!Number.isFinite(total) || !Number.isInteger(months) || months < 1) return [];
  const sign = total < 0 ? -1 : 1;
  const cents = Math.round(round2(Math.abs(total)) * 100);
  const part = Math.floor(cents / (months * 100)) * 100;
  const amounts: number[] = [];
  for (let i = 0; i < months - 1; i++) amounts.push(sign * (part / 100));
  amounts.push(sign * ((cents - part * (months - 1)) / 100));
  // -0 would print as "0" but compare unequal to 0 in tests; normalise.
  return amounts.map((a) => round2(a) + 0);
}

// Intäktskonton (revenue nature) are the income-statement lines netSales,
// otherOperatingIncome and financialIncome: 3000–3999 and 8000–8399. Everything
// else in class 3–8 is a cost. Mirrors the server's budgetSign (the budget is
// entered in the account's natural sign: revenue positive on a revenue account,
// cost positive on a cost account).
export function isRevenueAccount(accountNumber: string): boolean {
  const n = Number(accountNumber);
  if (!Number.isInteger(n)) return false;
  return (n >= 3000 && n <= 3999) || (n >= 8000 && n <= 8399);
}

// The accounts a budget can hold: class 3–8 except 8990–8999 (the booked
// result of the year).
export function isBudgetableAccount(accountNumber: string): boolean {
  if (!/^\d{4}$/.test(accountNumber)) return false;
  const n = Number(accountNumber);
  return n >= 3000 && n <= 8999 && !(n >= 8990 && n <= 8999);
}

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "maj", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];

// "2026-01" → "jan 26" (the column header of a month).
export function monthShortLabel(label: string): string {
  const match = /^(\d{4})-(\d{2})/.exec(label);
  if (!match) return label;
  const name = MONTH_NAMES[Number(match[2]) - 1];
  return name ? `${name} ${match[1]!.slice(2)}` : label;
}

// A cell as typed: "" is 0, anything unparsable is 0 too (the number input
// only lets valid numbers through, and a comma is accepted for a pasted value).
export function parseAmount(text: string): number {
  const n = Number(text.trim().replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

// 0 shows as an empty cell; anything else as plain digits for the input.
export function amountText(n: number): string {
  return n === 0 || !Number.isFinite(n) ? "" : String(round2(n));
}

export interface BudgetEditRow {
  key: string;
  accountNumber: string;
  accountName: string;
  // One text per month ("" = 0).
  amounts: string[];
  // The annual amount being typed in the Summa column, before Fördela
  // årsbelopp jämnt applies it. null = Summa shows the sum of the months.
  annual: string | null;
}

export function rowSum(row: BudgetEditRow): number {
  return round2(row.amounts.reduce((sum, a) => sum + parseAmount(a), 0));
}

export function isBlankRow(row: BudgetEditRow): boolean {
  return row.accountNumber === "" && row.amounts.every((a) => parseAmount(a) === 0) && (row.annual ?? "") === "";
}

// Fördela årsbelopp jämnt on one row: the typed annual amount (or, without
// one, the current sum) over the months. An empty/zero amount leaves the row.
export function distributeRow(row: BudgetEditRow): BudgetEditRow {
  const total = row.annual !== null && row.annual.trim() !== "" ? parseAmount(row.annual) : rowSum(row);
  if (total === 0) return { ...row, annual: null };
  return { ...row, amounts: distributeAnnual(total, row.amounts.length).map(amountText), annual: null };
}

export interface BudgetMonthSums {
  revenue: number[];
  costs: number[];
  result: number[];
}

// The summary rows under the grid: Intäkter, Kostnader and Resultat per month
// (revenue − costs, both in natural sign).
export function monthSums(rows: BudgetEditRow[], months: number): BudgetMonthSums {
  const revenue = new Array<number>(months).fill(0);
  const costs = new Array<number>(months).fill(0);
  for (const row of rows) {
    if (row.accountNumber === "") continue;
    const target = isRevenueAccount(row.accountNumber) ? revenue : costs;
    for (let i = 0; i < months; i++) target[i] = round2(target[i]! + parseAmount(row.amounts[i] ?? ""));
  }
  return { revenue, costs, result: revenue.map((r, i) => round2(r - costs[i]!)) };
}

export function sumOf(values: number[]): number {
  return round2(values.reduce((s, v) => s + v, 0));
}

// What identifies the saved state of a tab: the account and its amounts, blank
// rows ignored. Compared with the signature of the loaded rows for "dirty".
export function rowsSignature(rows: BudgetEditRow[]): string {
  return JSON.stringify(
    rows
      .filter((r) => r.accountNumber !== "" || r.amounts.some((a) => parseAmount(a) !== 0))
      .map((r) => [r.accountNumber, r.amounts.map((a) => parseAmount(a))])
  );
}

export interface BudgetPutLine {
  accountNumber: string;
  amounts: number[];
}

// The body of PUT /budgets/:id/lines for one tab. Blank rows are dropped; an
// amount on a row without an account, or the same account twice, is an error
// the user fixes before anything is sent.
export function toPutLines(rows: BudgetEditRow[]): { lines: BudgetPutLine[]; error: string | null } {
  const lines: BudgetPutLine[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const amounts = row.amounts.map((a) => round2(parseAmount(a)));
    const hasAmount = amounts.some((a) => a !== 0);
    if (row.accountNumber === "") {
      if (hasAmount) return { lines: [], error: "Välj konto på alla rader som har belopp." };
      continue;
    }
    if (seen.has(row.accountNumber)) {
      return { lines: [], error: `Konto ${row.accountNumber} finns på flera rader — slå ihop dem.` };
    }
    seen.add(row.accountNumber);
    lines.push({ accountNumber: row.accountNumber, amounts });
  }
  return { lines, error: null };
}
