// Årsbokslut — every amount the closing books, and the date arithmetic it
// needs. Pure leaf (no DB imports), like depreciation-schedule.ts; signed
// amounts are debit-positive, the poster's accumulator convention.
import { ACCRUAL_KIND_BALANCE_SIDE, round2, type YearEndAccrualKind } from "@navet/shared";

export type SignedAmount = { accountId: string; amount: number };

function parse(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}

function format(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const result = parse(date);
  result.setUTCDate(result.getUTCDate() + days);
  return format(result);
}

// Same day of month N months later, clamped to the target month's last day.
export function addMonthsToDate(date: string, months: number): string {
  const source = parse(date);
  const target = new Date(Date.UTC(source.getUTCFullYear(), source.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(source.getUTCDate(), lastDay));
  return format(target);
}

// The year the accrual step creates when none covers the day after year end:
// 12 months from that day. "2025" for a calendar year, else "2024/25".
export function nextFiscalYearBounds(year: { endDate: string }): { label: string; startDate: string; endDate: string } {
  const startDate = addDays(year.endDate, 1);
  const endDate = addDays(addMonthsToDate(startDate, 12), -1);
  const calendar = startDate.endsWith("-01-01") && endDate.endsWith("-12-31") && startDate.slice(0, 4) === endDate.slice(0, 4);
  const label = calendar ? startDate.slice(0, 4) : `${startDate.slice(0, 4)}/${endDate.slice(2, 4)}`;
  return { label, startDate, endDate };
}

// Steg 2: value − ledger (the ledger WITHOUT the step's own live booking).
export function inventoryAmounts(input: {
  inventoryAccountId: string;
  changeAccountId: string;
  value: number;
  ledgerBalance: number;
}): { difference: number; amounts: SignedAmount[] } {
  const difference = round2(input.value - input.ledgerBalance);
  if (difference === 0) return { difference, amounts: [] };
  return {
    difference,
    amounts: [
      { accountId: input.inventoryAccountId, amount: difference },
      { accountId: input.changeAccountId, amount: -difference },
    ],
  };
}

export interface AccrualSpec {
  kind: YearEndAccrualKind;
  balanceAccountId: string;
  resultAccountId: string;
  amount: number;
  description: string;
}

// Steg 4: the year's verification. The reversal is mirrorAmounts() of this.
export function accrualAmounts(rows: Pick<AccrualSpec, "kind" | "balanceAccountId" | "resultAccountId" | "amount">[]): SignedAmount[] {
  return rows.flatMap((row) => {
    const amount = round2(row.amount);
    const sign = ACCRUAL_KIND_BALANCE_SIDE[row.kind] === "debit" ? 1 : -1;
    return [
      { accountId: row.balanceAccountId, amount: sign * amount },
      { accountId: row.resultAccountId, amount: -sign * amount },
    ];
  });
}

export function mirrorAmounts(amounts: SignedAmount[]): SignedAmount[] {
  return amounts.map((row) => ({ accountId: row.accountId, amount: -row.amount }));
}

// "Is the requested set exactly what is already booked?" — the accrual
// step's unchanged test. Order matters (sort_order is part of the spec).
export function sameAccrualSet(a: AccrualSpec[], b: AccrualSpec[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((row, index) => {
    const other = b[index]!;
    return (
      row.kind === other.kind &&
      row.balanceAccountId === other.balanceAccountId &&
      row.resultAccountId === other.resultAccountId &&
      round2(row.amount) === round2(other.amount) &&
      row.description === other.description
    );
  });
}

// Steg 5: net = Σ (kredit − debet) över årets klass 3–8. Profit ⇒ debet 8999.
export function resultTransferAmounts(input: { net: number; resultAccountId: string; equityAccountId: string }): SignedAmount[] {
  const amount = round2(input.net);
  if (amount === 0) return [];
  return [
    { accountId: input.resultAccountId, amount },
    { accountId: input.equityAccountId, amount: -amount },
  ];
}

// Vinstdisposition. resultAmount = 2099's credit balance (negative for a loss).
export function profitDispositionAmounts(input: {
  resultAmount: number;
  dividend: number;
  resultEquityAccountId: string;
  retainedAccountId: string;
  dividendAccountId: string;
}): SignedAmount[] {
  const result = round2(input.resultAmount);
  const dividend = round2(input.dividend);
  const retained = round2(result - dividend);
  const amounts: SignedAmount[] = [];
  if (result !== 0) amounts.push({ accountId: input.resultEquityAccountId, amount: result });
  if (dividend !== 0) amounts.push({ accountId: input.dividendAccountId, amount: -dividend });
  if (retained !== 0) amounts.push({ accountId: input.retainedAccountId, amount: -retained });
  return amounts;
}

// Nets per account (first-seen order) into the debit/credit shape previews
// show — the same arithmetic as the poster's accumulator.
export function toDebitCredit(amounts: SignedAmount[]): { accountId: string; debit: number; credit: number }[] {
  const net = new Map<string, number>();
  for (const row of amounts) net.set(row.accountId, round2((net.get(row.accountId) ?? 0) + row.amount));
  return [...net.entries()]
    .filter(([, value]) => value !== 0)
    .map(([accountId, value]) => ({ accountId, debit: value > 0 ? value : 0, credit: value < 0 ? -value : 0 }));
}
