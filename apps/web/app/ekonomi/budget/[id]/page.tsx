import { headers } from "next/headers";
import { AppShell } from "../../../../components/AppShell";
import { BudgetDetailPageClient } from "../../../../components/economy/BudgetDetailPageClient";
import { apiGet, getCurrentUser } from "../../../../lib/api";
import type { PageSearchParams } from "../../../../lib/listQuery";
import type { Account, BudgetDetail, FiscalYear, Paged } from "../../../../lib/types";
import { canOpen } from "../../../../lib/pageAccess";

export default async function BudgetDetailPage(props: {
  params: Promise<{ id: string }>;
  searchParams: Promise<PageSearchParams>;
}) {
  const { id } = await props.params;
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

  const [detail, accounts, fiscalYears] = await Promise.all([
    apiGet<BudgetDetail>(`/api/v1/budgets/${id}`, cookieHeader),
    apiGet<Paged<Account>>("/api/v1/accounts?limit=1000", cookieHeader),
    apiGet<FiscalYear[]>("/api/v1/fiscal-years", cookieHeader),
  ]);
  const dropped = Number(typeof searchParams.dropped === "string" ? searchParams.dropped : 0);

  return (
    <AppShell active="Ekonomi">
      <BudgetDetailPageClient
        initial={detail}
        accounts={accounts.rows}
        fiscalYears={fiscalYears}
        dropped={Number.isInteger(dropped) && dropped > 0 ? dropped : 0}
      />
    </AppShell>
  );
}
