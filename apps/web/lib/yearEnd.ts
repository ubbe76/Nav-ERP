// Mirror of @navet/shared's year-end labels and the accrual sign table (the
// web cannot import @navet/shared — Turbopack vs .js-suffix imports). Kept in
// sync by apps/api/test/year-end.shared.test.ts. No imports: vitest loads it.

export type YearEndAccrualKind = "prepaid_expense" | "accrued_income" | "accrued_expense" | "prepaid_income";
export type YearEndStep = "inventory" | "accruals" | "result_transfer" | "profit_disposition" | "fx_revaluation";
export type YearEndRole = "booking" | "accrual_reversal" | "cancellation" | "fx_reversal";
export type PillStatus = "done" | "delayed" | "draft" | "stopped";

export const YEAR_END_ACCRUAL_KIND_LABELS: Record<YearEndAccrualKind, string> = {
  prepaid_expense: "Förutbetald kostnad",
  accrued_income: "Upplupen intäkt",
  accrued_expense: "Upplupen kostnad",
  prepaid_income: "Förutbetald intäkt",
};

export const ACCRUAL_KIND_BALANCE_SIDE: Record<YearEndAccrualKind, "debit" | "credit"> = {
  prepaid_expense: "debit",
  accrued_income: "debit",
  accrued_expense: "credit",
  prepaid_income: "credit",
};

export const YEAR_END_STEP_LABELS: Record<YearEndStep, string> = {
  inventory: "Lagerförändring",
  accruals: "Periodiseringar",
  result_transfer: "Resultatöverföring",
  profit_disposition: "Vinstdisposition",
  fx_revaluation: "Valutaomvärdering",
};

export const YEAR_END_ROLE_LABELS: Record<YearEndRole, string> = {
  booking: "Bokföring",
  accrual_reversal: "Återföring",
  cancellation: "Omföring",
  fx_reversal: "Återföring",
};

// Förvalt balanskonto när typen väljs.
export const DEFAULT_BALANCE_ACCOUNT: Record<YearEndAccrualKind, string> = {
  prepaid_expense: "1790",
  accrued_income: "1790",
  accrued_expense: "2990",
  prepaid_income: "2990",
};

export const STEP_STATUS_PILL: Record<"done" | "stale" | "not_done" | "missing" | "blocked" | "warnings", { status: PillStatus; label: string }> = {
  done: { status: "done", label: "Klar" },
  stale: { status: "delayed", label: "Inaktuell" },
  not_done: { status: "draft", label: "Ej gjord" },
  missing: { status: "draft", label: "Ej gjord" },
  blocked: { status: "stopped", label: "Spärrad" },
  warnings: { status: "delayed", label: "Varningar" },
};

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

// The accrual verification as the guide will book it, netted per account —
// same sign table as the API's year-end-calc.ts accrualAmounts + toDebitCredit.
export function accrualPreview(
  rows: { kind: YearEndAccrualKind; balanceAccountId: string; resultAccountId: string; amount: number }[]
): { accountId: string; debit: number; credit: number }[] {
  const net = new Map<string, number>();
  for (const row of rows) {
    const amount = round2(row.amount);
    const sign = ACCRUAL_KIND_BALANCE_SIDE[row.kind] === "debit" ? 1 : -1;
    net.set(row.balanceAccountId, round2((net.get(row.balanceAccountId) ?? 0) + sign * amount));
    net.set(row.resultAccountId, round2((net.get(row.resultAccountId) ?? 0) - sign * amount));
  }
  return [...net.entries()]
    .filter(([, value]) => value !== 0)
    .map(([accountId, value]) => ({ accountId, debit: value > 0 ? value : 0, credit: value < 0 ? -value : 0 }));
}

export function stockholmToday(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm" }).format(new Date());
}

// The guide's default year: the OLDEST open year that has ended, else the
// year covering today, else the newest.
export function defaultFiscalYearId(
  years: { id: string; startDate: string; endDate: string; status: "open" | "closed" }[],
  today: string
): string | null {
  const ended = years.filter((y) => y.status === "open" && y.endDate < today).sort((a, b) => a.endDate.localeCompare(b.endDate));
  if (ended[0]) return ended[0].id;
  return years.find((y) => y.startDate <= today && y.endDate >= today)?.id ?? years[0]?.id ?? null;
}

// Periodiseringsrader not yet booked carry ids new-1, new-2, … (the UUID API
// is missing outside a secure context). After a reload restores them from
// localStorage the counter must continue past the highest one, or the next
// added row would reuse a React key.
export function highestNewRowSeq(ids: string[]): number {
  return ids.reduce((max, id) => {
    const match = /^new-(\d+)$/.exec(id);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
}
