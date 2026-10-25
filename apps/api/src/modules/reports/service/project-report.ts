import { round2, type ProjectReportAccount, type ProjectReportMonth } from "@navet/shared";
import { classifyAccount } from "../../economy/service/bas-report-lines.js";

// Projektrapport (kostnadsställen och projekt) — the pure half: the booked
// verification rows carrying one project, folded into revenue, costs and
// result per month and per account. Only result accounts (class 3–8) count;
// a balance account that happens to carry the project (a prepayment on 1510)
// is neither revenue nor cost and is left out. Revenue = class 3 credit
// positive, costs = class 4–8 debit positive, result = revenue − costs;
// `amount` on an account is its result contribution (credit − debit), so the
// accounts sum to the result.

export interface ProjectRowSource {
  date: string; // YYYY-MM-DD
  accountNumber: string;
  accountName: string;
  debit: number;
  credit: number;
}

export interface ProjectReportTotals {
  revenue: number;
  costs: number;
  result: number;
  months: ProjectReportMonth[];
  accounts: ProjectReportAccount[];
}

export function isRevenueAccount(accountNumber: string): boolean {
  return classifyAccount(accountNumber).report === "incomeStatement" && accountNumber < "4000";
}

export function isCostAccount(accountNumber: string): boolean {
  return classifyAccount(accountNumber).report === "incomeStatement" && accountNumber >= "4000";
}

export function buildProjectReport(rows: ProjectRowSource[]): ProjectReportTotals {
  let revenue = 0;
  let costs = 0;
  const months = new Map<string, { revenue: number; costs: number }>();
  const accounts = new Map<string, ProjectReportAccount>();

  for (const row of rows) {
    const isRevenue = isRevenueAccount(row.accountNumber);
    const isCost = isCostAccount(row.accountNumber);
    if (!isRevenue && !isCost) continue;
    const month = row.date.slice(0, 7);
    const bucket = months.get(month) ?? { revenue: 0, costs: 0 };
    if (isRevenue) {
      const net = round2(row.credit - row.debit);
      revenue = round2(revenue + net);
      bucket.revenue = round2(bucket.revenue + net);
    } else {
      const net = round2(row.debit - row.credit);
      costs = round2(costs + net);
      bucket.costs = round2(bucket.costs + net);
    }
    months.set(month, bucket);
    const account = accounts.get(row.accountNumber) ?? { accountNumber: row.accountNumber, accountName: row.accountName, amount: 0 };
    account.amount = round2(account.amount + row.credit - row.debit);
    accounts.set(row.accountNumber, account);
  }

  return {
    revenue,
    costs,
    result: round2(revenue - costs),
    months: [...months.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, bucket]) => ({ month, revenue: bucket.revenue, costs: bucket.costs, result: round2(bucket.revenue - bucket.costs) })),
    accounts: [...accounts.values()].sort((a, b) => a.accountNumber.localeCompare(b.accountNumber)),
  };
}
