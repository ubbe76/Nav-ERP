import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { BankavstamningPageClient } from "../../../components/economy/BankavstamningPageClient";
import { apiGet, getCurrentUser } from "../../../lib/api";
import { defaultPeriod, isIsoDate } from "../../../lib/bankReconciliation";
import { apiErrorMessage } from "../../../lib/errorMessages";
import type { Account, BankAccount, BankReconciliationView, Paged } from "../../../lib/types";
import { canOpen } from "../../../lib/pageAccess";

// ?account=<bank account id>&from=&to= — the account defaults to the first
// active one, the period to the current year up to today.
export default async function BankavstamningPage(props: {
  searchParams: Promise<{ account?: string; from?: string; to?: string }>;
}) {
  const params = await props.searchParams;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);

  if (!user || !canOpen(user, "/ekonomi/bankavstamning")) {
    return (
      <AppShell active="Ekonomi">
        <p>Du saknar behörighet till den här sidan.</p>
      </AppShell>
    );
  }

  const [bankAccounts, accounts] = await Promise.all([
    apiGet<{ rows: BankAccount[]; total: number }>("/api/v1/bank-accounts?includeInactive=true", cookieHeader),
    apiGet<Paged<Account>>("/api/v1/accounts?limit=1000", cookieHeader),
  ]);

  const fallback = defaultPeriod();
  const from = isIsoDate(params.from) ? params.from : fallback.from;
  const to = isIsoDate(params.to) ? params.to : fallback.to;
  const selected =
    bankAccounts.rows.find((a) => a.id === params.account) ?? bankAccounts.rows.find((a) => a.active) ?? bankAccounts.rows[0] ?? null;

  let view: BankReconciliationView | null = null;
  let viewError: string | null = null;
  if (selected) {
    try {
      view = await apiGet<BankReconciliationView>(
        `/api/v1/bank-reconciliation?bankAccountId=${encodeURIComponent(selected.id)}&from=${from}&to=${to}`,
        cookieHeader
      );
    } catch (err) {
      viewError = apiErrorMessage(err, "Avstämningen kunde inte hämtas");
    }
  }

  return (
    <AppShell active="Ekonomi">
      <BankavstamningPageClient
        bankAccounts={bankAccounts.rows}
        selectedId={selected?.id ?? null}
        view={view}
        viewError={viewError}
        from={from}
        to={to}
        accounts={accounts.rows}
      />
    </AppShell>
  );
}
