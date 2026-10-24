import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { BankkontonPageClient } from "../../../components/economy/BankkontonPageClient";
import { apiGet, getCurrentUser } from "../../../lib/api";
import type { Account, BankAccount, Paged } from "../../../lib/types";
import { canOpen } from "../../../lib/pageAccess";

export default async function BankkontonPage() {
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);

  if (!user || !canOpen(user, "/ekonomi/bankkonton")) {
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

  return (
    <AppShell active="Ekonomi">
      <BankkontonPageClient bankAccounts={bankAccounts.rows} accounts={accounts.rows} />
    </AppShell>
  );
}
