import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { BudgetListPageClient } from "../../../components/economy/BudgetListPageClient";
import { apiGet, getCurrentUser } from "../../../lib/api";
import { stockholmToday } from "../../../lib/date";
import type { PageSearchParams } from "../../../lib/listQuery";
import type { BudgetSummary, FiscalYear } from "../../../lib/types";
import { canOpen } from "../../../lib/pageAccess";

function singleParam(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

export default async function BudgetPage(props: { searchParams: Promise<PageSearchParams> }) {
  const searchParams = await props.searchParams;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);

  if (!user || !canOpen(user, "/ekonomi/budget")) {
    return (
      <AppShell active="Ekonomi">
        <p>Du saknar behörighet till den här sidan.</p>
      </AppShell>
    );
  }

  const fiscalYears = await apiGet<FiscalYear[]>("/api/v1/fiscal-years", cookieHeader);
  const today = stockholmToday();
  const requested = singleParam(searchParams.fiscalYearId);
  // The year asked for, else the one that contains today, else the latest.
  const selected =
    fiscalYears.find((y) => y.id === requested) ??
    fiscalYears.find((y) => y.startDate <= today && today <= y.endDate) ??
    fiscalYears[0];

  const budgets = selected
    ? await apiGet<{ rows: BudgetSummary[]; total: number }>(`/api/v1/budgets?fiscalYearId=${selected.id}`, cookieHeader)
    : { rows: [], total: 0 };

  return (
    <AppShell active="Ekonomi">
      <BudgetListPageClient fiscalYears={fiscalYears} fiscalYearId={selected?.id ?? ""} budgets={budgets.rows} />
    </AppShell>
  );
}
